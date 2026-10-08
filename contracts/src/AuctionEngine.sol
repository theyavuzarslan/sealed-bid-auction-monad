// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SealingLayer} from "./SealingLayer.sol";
import {UniformClearing} from "./UniformClearing.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {IDexAdapter, IUniV3LPLocker, IERC721Minimal, IERC20Minimal} from "./interfaces/ILiquidity.sol";

/// @title AuctionEngine — sealed-bid fair launch (Degen and Raise presets)
/// @notice Round lifecycle: openRound → commit → reveal → settle → seedLP (or abandonLP) → claim.
///         A bid is a max price per token plus a token amount (10-decisions.md #22). Winners pay the
///         uniform clearing price; the overpayment is refunded from their uniform deposit.
/// @dev Money flows, all per round and all checked by `roundBalance` / `tokensOut`:
///      - MON in: one uniform deposit per commit.
///      - MON out: refunds (available as soon as the round is settled, independent of the token);
///        unrevealed deposits burned (#30); the LP share (#25), or burned if the LP is abandoned;
///        creator proceeds.
///      - Tokens in: `sellAmount` for the auction plus the worst-case LP reserve, pulled at open.
///      - Tokens out: allocations (or vested, Raise #32); the LP position; unsold supply, burned for
///        Degen and returned for Raise (#29), or returned if nothing sold at all.
///      Tokens are delivered only after the LP is seeded, so no auctioned token exists outside the
///      contract before the pool does (#27, bug #7). The LP is only ever seeded at the clearing price.
///      If seeding stays blocked for `lpGracePeriod`, anyone can abandon the LP: its MON share is
///      burned and token delivery opens. Burning, rather than returning, means nobody — least of all
///      the creator — gains from blocking the pool (AUDIT.md, second review, H1).
///      Refunds never depend on the token: a paused or blacklisting token cannot hold MON hostage (M2).
contract AuctionEngine is SealingLayer, UniformClearing {
    using SafeTransferLib for address;

    /// @notice Prices are MON wei per 1e18 token units: paying for `amount` at `price` costs
    ///         `amount × price / PRICE_SCALE` MON wei.
    uint256 public constant PRICE_SCALE = 1e18;
    /// @notice Basis-point denominator (100%).
    uint256 public constant BPS = 10_000;
    /// @notice Most DEX venues one round's LP may be split across.
    uint256 public constant MAX_SPLITS = 4;
    /// @notice Shortest LP lock a Raise round may choose.
    uint256 public constant MIN_RAISE_LOCK = 30 days;

    /// @notice Degen: open, LP locked forever, unsold supply burned, no vesting.
    ///         Raise: optional allowlist, LP lock and vesting; unsold supply returned to the creator.
    enum Preset {
        Degen,
        Raise
    }

    /// @notice One LP venue: an allow-listed adapter, its share of the LP in bps, and its fee tier.
    struct DexSplit {
        address adapter;
        uint16 bps;
        uint24 fee;
    }

    /// @notice Everything a creator sets when opening a round. Validated by `_validate`.
    struct OpenParams {
        Preset preset;
        address token;
        uint128 sellAmount;
        uint96 depositAmount;
        uint96 minBidSize; // minimum of amount × reservePrice, in MON wei
        uint96 tickSize; // price grid, MON wei per 1e18 token units
        uint96 reservePrice;
        uint64 commitEnd;
        uint64 revealEnd;
        bytes32 allowlistRoot; // Raise only; zero = open
        string allowlistURI; // where bidders fetch the tree to build proofs
        uint16 lpShareBps; // share of tokens sold and MON raised that goes to the LP
        DexSplit[] dexSplits;
        uint64 lockDuration; // Raise only: LP lock length from seeding; Degen locks are permanent
        string lockFeeTier; // GoPlus fee name: DEFAULT, LVP or LLP
        uint16 tgeBps; // Raise vesting: share delivered at claim
        uint64 cliff;
        uint64 vestDuration; // 0 = no vesting
    }

    /// @notice A round's terms (from `OpenParams`) and its post-settlement accounting.
    struct Round {
        address creator;
        address token;
        Preset preset;
        uint16 lpShareBps;
        uint16 tgeBps;
        uint128 sellAmount;
        uint128 tokenReserve; // worst-case LP token side, pulled at open: sellAmount × lpShareBps / BPS
        uint96 depositAmount;
        uint96 minBidSize;
        uint96 tickSize;
        uint96 reservePrice;
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 lockDuration;
        uint64 cliff;
        uint64 vestDuration;
        uint64 settledAt; // when settlement finished; vesting cliff and LP grace period start here
        bytes32 allowlistRoot;
        string lockFeeTier;
        bool claimsOpen; // token delivery is open (LP seeded or abandoned)
        bool lpDone;
        bool lpAbandoned;
        bool dustSwept;
        uint256 lpMonSpent; // MON the pools took
        uint256 lpMonBurned; // the LP's MON share, burned by `abandonLP`
        uint256 lpTokensUsed; // tokens the pools took
        uint256 collected; // MON paid by settled bidders
        uint256 withdrawn; // MON withdrawn by the creator
        uint256 allocatedTotal; // tokens allocated to settled bidders
        uint256 unsoldOwed; // tokens owed to the unsold recipient, not yet transferred
        uint256 tokensOut; // every token that has left the engine for this round
    }

    /// @notice A revealed bid: max price per token (MON wei per 1e18 units) and token amount.
    struct Bid {
        uint96 price;
        uint96 amount;
    }

    /// @notice A Raise allocation under vesting.
    struct Vest {
        uint128 total;
        uint128 released;
    }

    /// @notice GoPlus UniV3LPLocker that every seeded position is locked in.
    IUniV3LPLocker public immutable locker;
    /// @notice Unlock time passed to the locker for Degen rounds (the engine never unlocks them).
    uint256 public immutable permanentLockEnd;
    /// @notice How long after settlement seeding may stay blocked before anyone can `abandonLP`.
    uint256 public immutable lpGracePeriod;
    /// @notice DEX adapters a round may seed through, fixed at deployment.
    mapping(address => bool) public isAdapter;

    /// @notice Number of rounds opened; round ids run from 1 to `roundCount`.
    uint256 public roundCount;
    mapping(uint256 => Round) internal _rounds;
    mapping(uint256 => DexSplit[]) internal _splits;
    /// @notice Each bidder's revealed bid per round.
    mapping(uint256 => mapping(address => Bid)) public bids;
    /// @notice Each bidder's vesting schedule per Raise round with vesting.
    mapping(uint256 => mapping(address => Vest)) public vests;
    /// @notice Whether a bidder's tokens for a round have been delivered.
    mapping(uint256 => mapping(address => bool)) public tokensClaimed;
    /// @dev True only while `_seed` runs: the window in which `receive` accepts MON from an adapter.
    bool private _seeding;

    /// @notice A round was opened. `allowlistURI` tells bidders where to fetch the allowlist tree.
    event RoundOpened(
        uint256 indexed roundId, address indexed creator, address indexed token, Preset preset, string allowlistURI
    );
    /// @notice Settlement finished: the clearing price and the nominal amount sold are final.
    event Cleared(uint256 indexed roundId, uint256 clearingPrice, uint256 sold, bool oversubscribed);
    /// @notice One LP split was seeded and its position locked (`lockId` in the GoPlus locker).
    event LPSeeded(
        uint256 indexed roundId,
        address indexed adapter,
        address positionManager,
        uint256 nftId,
        uint256 tokenAmount,
        uint256 monAmount,
        uint256 lockId
    );
    /// @notice Seeding was abandoned after the grace period; the LP's MON share was burned.
    event LPAbandoned(uint256 indexed roundId, uint256 monBurned);
    /// @notice Token delivery opened, with (`lpSeeded`) or without an LP.
    event ClaimsOpened(uint256 indexed roundId, bool lpSeeded);
    /// @notice Unsold supply and dust went to `to`: the creator, or the burn address.
    event UnsoldDisposed(uint256 indexed roundId, address indexed to, uint256 amount);
    /// @notice A revealed bidder's deposit was settled: `allocated` tokens won, `paid` kept, `refund` sent.
    event Claimed(uint256 indexed roundId, address indexed bidder, uint256 allocated, uint256 paid, uint256 refund);
    /// @notice Tokens delivered at claim (the TGE share for a vesting round).
    event TokensClaimed(uint256 indexed roundId, address indexed bidder, uint256 amount);
    /// @notice Vested tokens released.
    event VestedClaimed(uint256 indexed roundId, address indexed bidder, uint256 amount);
    /// @notice The creator withdrew `amount` MON of proceeds.
    event ProceedsWithdrawn(uint256 indexed roundId, uint256 amount);

    /// @param locker_           GoPlus UniV3LPLocker.
    /// @param adapters_         The only DEX adapters creators may choose; fixed forever, so no creator can
    ///                          route LP proceeds to a contract of their own.
    /// @param permanentLockEnd_ Unlock time passed to the locker for Degen rounds. The engine is the lock
    ///                          owner and has no unlock path, so the lock is permanent regardless.
    /// @param lpGracePeriod_    How long after settlement seeding may stay blocked before anyone can abandon it.
    constructor(address locker_, address[] memory adapters_, uint256 permanentLockEnd_, uint256 lpGracePeriod_) {
        require(locker_.code.length != 0, "locker has no code");
        require(permanentLockEnd_ > block.timestamp, "lock end in past");
        require(lpGracePeriod_ != 0, "zero grace period");
        locker = IUniV3LPLocker(locker_);
        permanentLockEnd = permanentLockEnd_;
        lpGracePeriod = lpGracePeriod_;
        for (uint256 i; i < adapters_.length; ++i) {
            require(adapters_[i].code.length != 0, "adapter has no code");
            isAdapter[adapters_[i]] = true;
        }
    }

    /// @dev Only adapters return MON, and only while seeding: anything else would be unaccounted.
    receive() external payable {
        require(_seeding && isAdapter[msg.sender], "unexpected MON");
    }

    /// @notice Accepts ERC-721 transfers (Uniswap v3 positions minted to the engine before locking).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ─── Open ────────────────────────────────────────────────────────────

    /// @notice Open a round and pull `sellAmount` plus the worst-case LP reserve from the caller, who
    ///         becomes its creator (approve the engine for both first).
    /// @param p The round's terms; see `OpenParams` and `_validate`.
    /// @return roundId The new round's id.
    function openRound(OpenParams calldata p) external nonReentrant returns (uint256 roundId) {
        _validate(p);
        roundId = ++roundCount;
        Round storage r = _rounds[roundId];
        r.creator = msg.sender;
        r.token = p.token;
        r.preset = p.preset;
        r.lpShareBps = p.lpShareBps;
        r.tgeBps = p.tgeBps;
        r.sellAmount = p.sellAmount;
        // casting to 'uint128' is safe because `_validate` checked lpShareBps <= BPS, so the result is
        // at most sellAmount, a uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        r.tokenReserve = uint128(uint256(p.sellAmount) * p.lpShareBps / BPS);
        r.depositAmount = p.depositAmount;
        r.minBidSize = p.minBidSize;
        r.tickSize = p.tickSize;
        r.reservePrice = p.reservePrice;
        r.commitEnd = p.commitEnd;
        r.revealEnd = p.revealEnd;
        r.lockDuration = p.lockDuration;
        r.cliff = p.cliff;
        r.vestDuration = p.vestDuration;
        r.allowlistRoot = p.allowlistRoot;
        r.lockFeeTier = p.lockFeeTier;
        for (uint256 i; i < p.dexSplits.length; ++i) {
            _splits[roundId].push(p.dexSplits[i]);
        }
        _initBook(roundId, p.sellAmount);

        uint256 need = uint256(p.sellAmount) + r.tokenReserve;
        uint256 before = IERC20Minimal(p.token).balanceOf(address(this));
        p.token.safeTransferFrom(msg.sender, address(this), need);
        require(IERC20Minimal(p.token).balanceOf(address(this)) - before == need, "fee-on-transfer token");
        emit RoundOpened(roundId, msg.sender, p.token, p.preset, p.allowlistURI);
    }

    /// @dev Every `OpenParams` rule. Reverts with the first one broken.
    function _validate(OpenParams calldata p) private view {
        require(p.token.code.length != 0, "token has no code");
        require(p.sellAmount != 0, "zero sell amount");
        require(p.tickSize != 0, "zero tick");
        require(p.reservePrice != 0 && p.reservePrice % p.tickSize == 0, "reserve off grid");
        require(p.minBidSize != 0 && p.depositAmount > p.minBidSize, "deposit must exceed min bid");
        // Some amount at the reserve price must land in [minBidSize, depositAmount); otherwise no
        // bid can ever be valid and every deposit would be burned (second review, L2).
        require(
            uint256(p.reservePrice) <= (uint256(p.depositAmount) - p.minBidSize) * PRICE_SCALE, "no valid bid possible"
        );
        require(p.commitEnd > block.timestamp && p.revealEnd > p.commitEnd, "bad windows");
        require(p.lpShareBps <= BPS, "lp share > 100%");
        if (p.lpShareBps == 0) {
            require(p.dexSplits.length == 0, "splits without LP");
        } else {
            require(p.dexSplits.length != 0 && p.dexSplits.length <= MAX_SPLITS, "bad split count");
            uint256 sum;
            for (uint256 i; i < p.dexSplits.length; ++i) {
                require(isAdapter[p.dexSplits[i].adapter], "adapter not allowed");
                require(IDexAdapter(p.dexSplits[i].adapter).supportsFee(p.dexSplits[i].fee), "fee tier not supported");
                require(p.dexSplits[i].bps != 0, "zero split");
                sum += p.dexSplits[i].bps;
            }
            require(sum == BPS, "splits must sum to 100%");
            require(bytes(p.lockFeeTier).length != 0, "missing lock fee tier");
        }
        if (p.preset == Preset.Degen) {
            require(p.lpShareBps != 0, "degen needs LP");
            require(p.allowlistRoot == bytes32(0), "degen is open");
            require(p.tgeBps == 0 && p.cliff == 0 && p.vestDuration == 0, "degen has no vesting");
            require(p.lockDuration == 0, "degen lock is permanent");
        } else {
            if (p.vestDuration == 0) require(p.tgeBps == 0 && p.cliff == 0, "vesting fields without duration");
            else require(p.tgeBps < BPS, "tge must be below 100%");
            if (p.lpShareBps != 0) require(p.lockDuration >= MIN_RAISE_LOCK, "lock too short");
            else require(p.lockDuration == 0, "lock without LP");
        }
    }

    // ─── Commit / reveal hooks ──────────────────────────────────────────

    /// @dev SealingLayer hook: a round's deposit, windows and allowlist. Reverts for unknown rounds.
    function _sealTerms(uint256 roundId)
        internal
        view
        override
        returns (uint256 deposit, uint256 commitEnd, uint256 revealEnd, bytes32 allowlistRoot)
    {
        Round storage r = _rounds[roundId];
        require(r.creator != address(0), "unknown round");
        return (r.depositAmount, r.commitEnd, r.revealEnd, r.allowlistRoot);
    }

    /// @dev SealingLayer hook. price = MON wei per 1e18 token units, amount = token units. The bid's
    ///      worst-case cost (at its own price, rounded up) must fit in the deposit, so the deposit can
    ///      always pay for whatever the bid wins.
    function _onReveal(uint256 roundId, address bidder, uint96 price, uint96 amount, uint256 hint) internal override {
        Round storage r = _rounds[roundId];
        require(price % r.tickSize == 0 && price >= r.reservePrice, "price off grid or below reserve");
        require(amount != 0, "zero amount");
        require(_mulDivUp(price, amount, PRICE_SCALE) < r.depositAmount, "bid exceeds deposit");
        // The minimum applies to what the bid would pay at the reserve price, so every bid — and
        // every price level it creates — is worth at least minBidSize if it wins (second review, L3).
        require(_mulDivUp(r.reservePrice, amount, PRICE_SCALE) >= r.minBidSize, "below minimum bid");
        bids[roundId][bidder] = Bid(price, amount);
        _addBid(roundId, price, amount, hint);
    }

    // ─── Settle ─────────────────────────────────────────────────────────

    /// @notice Advance clearing by up to `maxSteps` price levels. Anyone, after the reveal window.
    /// @param roundId  The round to settle.
    /// @param maxSteps Most price levels to visit in this call (> 0); call again until it returns true.
    /// @return done    True once the clearing price is fixed.
    function settle(uint256 roundId, uint256 maxSteps) external nonReentrant returns (bool done) {
        Round storage r = _rounds[roundId];
        require(r.creator != address(0), "unknown round");
        require(block.timestamp >= r.revealEnd, "reveal window open");
        done = _settleStep(roundId, maxSteps);
        if (done) {
            // casting to 'uint64' is safe because timestamps fit in 64 bits for billions of years
            // forge-lint: disable-next-line(unsafe-typecast)
            r.settledAt = uint64(block.timestamp);
            Book storage b = _books[roundId];
            emit Cleared(roundId, b.clearingPrice, b.sold, b.oversubscribed);
        }
    }

    // ─── LP ─────────────────────────────────────────────────────────────

    /// @notice Seed and lock the LP at the clearing price, then open token delivery. Anyone, once settled.
    /// @dev A round without an LP share, or that sold nothing, seeds nothing and only opens delivery.
    /// @param roundId The settled round.
    function seedLP(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Book storage b = _books[roundId];
        require(b.settled, "not settled");
        require(!r.lpDone, "LP already done");
        (uint256 lpTokens, uint256 lpMon) = _lpTargets(roundId, r, b);
        bool seeded = lpTokens != 0 && lpMon != 0;
        if (seeded) _seed(roundId, r, b.clearingPrice, lpTokens, lpMon);
        r.lpDone = true;
        r.claimsOpen = true;
        _recordUnsold(r, b);
        emit ClaimsOpened(roundId, seeded);
    }

    /// @notice Liveness escape: if seeding stays blocked for `lpGracePeriod` after settlement, anyone may
    ///         abandon the LP. Its MON share is burned — not returned to anyone — so blocking the pool
    ///         never pays. Makes no token transfers, so a misbehaving token cannot block it either.
    /// @param roundId The settled round whose seeding is blocked.
    function abandonLP(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Book storage b = _books[roundId];
        require(b.settled, "not settled");
        require(!r.lpDone, "LP already done");
        require(block.timestamp >= uint256(r.settledAt) + lpGracePeriod, "grace period not over");
        (, uint256 lpMon) = _lpTargets(roundId, r, b);
        r.lpDone = true;
        r.lpAbandoned = true;
        r.claimsOpen = true;
        r.lpMonBurned = lpMon;
        _recordUnsold(r, b); // the whole reserve is unused
        if (lpMon != 0) _debit(roundId, lpMon);
        emit LPAbandoned(roundId, lpMon);
        emit ClaimsOpened(roundId, false);
        if (lpMon != 0) SafeTransferLib.sendValue(BURN, lpMon);
    }

    /// @notice Transfer unsold supply and dust owed to its recipient (burn for Degen, creator for Raise).
    ///         Separate and retryable, so opening claims never depends on this transfer succeeding.
    /// @param roundId The round whose LP is done.
    function disposeUnsold(uint256 roundId) external nonReentrant {
        _disposeOwed(roundId, _rounds[roundId]);
    }

    /// @dev The LP's token and MON sides: `lpShareBps` of the sold lower bound and of its value at P,
    ///      both rounded down, so the two sides match the clearing price. `_seed` debits the MON side checked.
    function _lpTargets(uint256 roundId, Round storage r, Book storage b)
        private
        view
        returns (uint256 lpTokens, uint256 lpMon)
    {
        uint256 soldLB = _soldLowerBound(roundId);
        if (r.lpShareBps == 0 || soldLB == 0) return (0, 0);
        lpTokens = soldLB * r.lpShareBps / BPS;
        lpMon = (soldLB * b.clearingPrice / PRICE_SCALE) * r.lpShareBps / BPS;
    }

    function _seed(uint256 roundId, Round storage r, uint256 price, uint256 lpTokens, uint256 lpMon) private {
        _debit(roundId, lpMon); // reverts if this round cannot cover it
        _seeding = true;
        DexSplit[] storage splits = _splits[roundId];
        uint256 tokensLeft = lpTokens;
        uint256 monLeft = lpMon;
        uint256 tokensUsed;
        uint256 monUsed;
        for (uint256 i; i < splits.length; ++i) {
            DexSplit memory s = splits[i];
            bool isLast = i == splits.length - 1;
            uint256 tok = isLast ? tokensLeft : lpTokens * s.bps / BPS;
            uint256 mon = isLast ? monLeft : lpMon * s.bps / BPS;
            tokensLeft -= tok;
            monLeft -= mon;
            (uint256 t, uint256 m) = _seedOne(roundId, r, s, price, tok, mon);
            tokensUsed += t;
            monUsed += m;
        }
        _seeding = false;
        r.lpTokensUsed = tokensUsed;
        r.lpMonSpent = monUsed;
        _tokensOut(r, tokensUsed);
        // Rounding dust the pool did not take stays with the round and reaches the creator.
        if (lpMon > monUsed) _credit(roundId, lpMon - monUsed);
    }

    /// @dev Seeds one split through its adapter, measures what it actually took by balance deltas,
    ///      and locks the position: owned by the engine forever (Degen) or by the creator until
    ///      `lockDuration` from now (Raise). Fees go to the creator either way.
    function _seedOne(uint256 roundId, Round storage r, DexSplit memory s, uint256 price, uint256 tok, uint256 mon)
        private
        returns (uint256 tokUsed, uint256 monUsed)
    {
        address token = r.token;
        uint256 tokBefore = IERC20Minimal(token).balanceOf(address(this));
        uint256 monBefore = address(this).balance;
        token.safeApprove(s.adapter, tok);
        (address npm, uint256 nftId) = IDexAdapter(s.adapter).seed{value: mon}(token, tok, price, s.fee, address(this));
        token.safeApprove(s.adapter, 0);
        tokUsed = tokBefore - IERC20Minimal(token).balanceOf(address(this));
        monUsed = monBefore - address(this).balance;
        require(tokUsed <= tok && monUsed <= mon, "adapter overspent");
        require(IERC721Minimal(npm).ownerOf(nftId) == address(this), "position not received");

        bool permanent = r.preset == Preset.Degen;
        IERC721Minimal(npm).approve(address(locker), nftId);
        uint256 lockId = locker.lock(
            npm,
            nftId,
            permanent ? address(this) : r.creator,
            r.creator,
            permanent ? permanentLockEnd : block.timestamp + r.lockDuration,
            r.lockFeeTier
        );
        emit LPSeeded(roundId, s.adapter, npm, nftId, tokUsed, monUsed, lockId);
    }

    /// @dev Called exactly once, when the LP is seeded or abandoned.
    function _recordUnsold(Round storage r, Book storage b) private {
        r.unsoldOwed += (uint256(r.sellAmount) - b.sold) + (uint256(r.tokenReserve) - r.lpTokensUsed);
    }

    /// @dev Transfers everything in `unsoldOwed` to its recipient. Effects before the transfer.
    function _disposeOwed(uint256 roundId, Round storage r) private {
        uint256 amount = r.unsoldOwed;
        require(amount != 0, "nothing to dispose");
        r.unsoldOwed = 0;
        address to = _unsoldRecipient(r, _books[roundId]);
        _tokensOut(r, amount);
        emit UnsoldDisposed(roundId, to, amount);
        r.token.safeTransfer(to, amount);
    }

    /// @dev Decision #29: Degen burns unsold supply, Raise returns it. A round that sold nothing
    ///      returns everything to the creator: there are no buyers to protect.
    function _unsoldRecipient(Round storage r, Book storage b) private view returns (address) {
        if (b.sold == 0 || r.preset == Preset.Raise) return r.creator;
        return BURN;
    }

    // ─── Claim ──────────────────────────────────────────────────────────

    /// @notice Refund and tokens for msg.sender, whichever are available and not yet claimed.
    /// @dev Cases: not refunded → refund, plus tokens if delivery is open; refunded but tokens pending
    ///      and delivery open → tokens; refunded and nothing deliverable → revert "nothing to claim".
    /// @param roundId The settled round.
    function claim(uint256 roundId) external nonReentrant {
        bool refunded = accounts[roundId][msg.sender].settled;
        if (!refunded) _refund(roundId, msg.sender);
        if (_rounds[roundId].claimsOpen && !tokensClaimed[roundId][msg.sender]) {
            _deliver(roundId, msg.sender);
        } else {
            require(!refunded, "nothing to claim");
        }
    }

    /// @notice Refund of `deposit − paid` to `bidder`. Anyone may trigger it; funds always go to the bidder.
    ///         Available as soon as the round is settled, whatever state the token or the LP is in.
    /// @param roundId The settled round.
    /// @param bidder  The revealed bidder to refund.
    function claimRefund(uint256 roundId, address bidder) external nonReentrant {
        _refund(roundId, bidder);
    }

    /// @notice Tokens won, to `bidder`. Anyone may trigger it; tokens always go to the bidder.
    /// @dev Settles the bidder's refund first if that has not happened yet.
    /// @param roundId A round whose claims are open.
    /// @param bidder  The revealed bidder to deliver to.
    function claimTokens(uint256 roundId, address bidder) external nonReentrant {
        if (!accounts[roundId][bidder].settled) _refund(roundId, bidder);
        _deliver(roundId, bidder);
    }

    /// @dev Settles a revealed bidder's deposit: pays `alloc × P` rounded up (bug #4), refunds the rest.
    ///      Effects first, the MON transfer last (bug #5).
    function _refund(uint256 roundId, address bidder) private {
        Round storage r = _rounds[roundId];
        require(_books[roundId].settled, "not settled");
        require(commitments[roundId][bidder].revealed, "not revealed");
        Bid memory bid = bids[roundId][bidder];
        uint256 alloc = _allocation(roundId, bid.price, bid.amount);
        uint256 paid = _mulDivUp(alloc, _books[roundId].clearingPrice, PRICE_SCALE);
        uint256 refund = _settleAccount(roundId, bidder, paid);
        r.collected += paid;
        r.allocatedTotal += alloc;
        emit Claimed(roundId, bidder, alloc, paid, refund);
        if (refund != 0) SafeTransferLib.sendValue(bidder, refund);
    }

    /// @dev Sends the bidder's allocation, or for a vesting round its TGE share and records the rest.
    function _deliver(uint256 roundId, address bidder) private {
        Round storage r = _rounds[roundId];
        require(r.claimsOpen, "claims not open");
        require(!tokensClaimed[roundId][bidder], "tokens already claimed");
        tokensClaimed[roundId][bidder] = true;
        Bid memory bid = bids[roundId][bidder];
        uint256 alloc = _allocation(roundId, bid.price, bid.amount);
        uint256 release = alloc;
        if (r.vestDuration != 0 && alloc != 0) {
            release = alloc * r.tgeBps / BPS;
            // casting to 'uint128' is safe because release <= alloc <= the bid's amount, a uint96
            // forge-lint: disable-next-line(unsafe-typecast)
            vests[roundId][bidder] = Vest(uint128(alloc), uint128(release));
        }
        emit TokensClaimed(roundId, bidder, release);
        if (release != 0) {
            _tokensOut(r, release);
            r.token.safeTransfer(bidder, release);
        }
    }

    /// @notice Raise rounds: release tokens vested since the last call.
    /// @param roundId A Raise round with vesting in which msg.sender has claimed their TGE share.
    function claimVested(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Vest storage v = vests[roundId][msg.sender];
        require(v.total != 0, "no vesting");
        uint256 vested = _vestedAmount(r, v.total);
        uint256 amount = vested - v.released;
        require(amount != 0, "nothing vested");
        // casting to 'uint128' is safe because vested <= v.total, a uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        v.released = uint128(vested);
        _tokensOut(r, amount);
        emit VestedClaimed(roundId, msg.sender, amount);
        r.token.safeTransfer(msg.sender, amount);
    }

    /// @notice Creator's share of the MON raised: payments collected so far, minus the LP's share
    ///         (spent on the pool, or burned if the LP was abandoned).
    /// @dev Grows as bidders are refunded; call again later for payments settled since.
    /// @param roundId A round created by msg.sender whose LP is done.
    function withdrawProceeds(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        require(msg.sender == r.creator, "not creator");
        require(r.lpDone, "LP not done");
        uint256 amount = _creatorAvailable(r);
        require(amount != 0, "nothing to withdraw");
        r.withdrawn += amount;
        _debit(roundId, amount);
        emit ProceedsWithdrawn(roundId, amount);
        SafeTransferLib.sendValue(r.creator, amount);
    }

    /// @notice Once every revealed bidder has been refunded, dispose of pro-rata rounding dust like unsold supply.
    /// @dev One-shot. Dust = nominal `sold` minus the sum of allocations.
    /// @param roundId A round whose LP is done and whose refunds are all claimed.
    function sweepDust(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Ledger storage l = ledgers[roundId];
        require(r.lpDone && !r.dustSwept, "not sweepable");
        require(l.claims == l.reveals, "refunds outstanding");
        r.dustSwept = true;
        r.unsoldOwed += _books[roundId].sold - r.allocatedTotal;
        if (r.unsoldOwed != 0) _disposeOwed(roundId, r);
    }

    // ─── Views ──────────────────────────────────────────────────────────

    /// @notice A round's full terms and accounting.
    /// @param roundId The round id (1..roundCount); an unknown id returns an all-zero struct.
    function getRound(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    /// @notice A round's LP splits, in seeding order.
    /// @param roundId The round id.
    function splitsOf(uint256 roundId) external view returns (DexSplit[] memory) {
        return _splits[roundId];
    }

    /// @notice What `bidder` receives: tokens allocated, MON paid, MON refunded. Reverts until settled.
    /// @param roundId The round id.
    /// @param bidder  A revealed bidder.
    /// @return allocated Tokens won.
    /// @return paid      MON paid at the clearing price, rounded up.
    /// @return refund    MON returned from the deposit.
    function quote(uint256 roundId, address bidder)
        external
        view
        returns (uint256 allocated, uint256 paid, uint256 refund)
    {
        require(commitments[roundId][bidder].revealed, "not revealed");
        Bid memory bid = bids[roundId][bidder];
        allocated = _allocation(roundId, bid.price, bid.amount);
        paid = _mulDivUp(allocated, _books[roundId].clearingPrice, PRICE_SCALE);
        refund = uint256(_rounds[roundId].depositAmount) - paid;
    }

    /// @notice A bidder's vesting progress in a Raise round with vesting; (0, 0) if none.
    /// @param roundId The round id.
    /// @param bidder  The bidder.
    /// @return vested   Tokens vested so far, TGE share included.
    /// @return released Tokens already delivered.
    function vestedOf(uint256 roundId, address bidder) external view returns (uint256 vested, uint256 released) {
        Vest storage v = vests[roundId][bidder];
        if (v.total == 0) return (0, 0);
        return (_vestedAmount(_rounds[roundId], v.total), v.released);
    }

    /// @notice MON the creator could withdraw now (`withdrawProceeds`).
    /// @param roundId The round id.
    function creatorAvailable(uint256 roundId) external view returns (uint256) {
        return _creatorAvailable(_rounds[roundId]);
    }

    // ─── Internals ──────────────────────────────────────────────────────

    /// @dev Payments collected minus the LP's MON (spent or burned), minus what was already withdrawn.
    function _creatorAvailable(Round storage r) private view returns (uint256) {
        uint256 lpCost = r.lpMonSpent + r.lpMonBurned;
        uint256 entitled = r.collected > lpCost ? r.collected - lpCost : 0;
        return entitled > r.withdrawn ? entitled - r.withdrawn : 0;
    }

    /// @dev TGE share at `settledAt + cliff`, then linear to `total` over `vestDuration`.
    function _vestedAmount(Round storage r, uint256 total) private view returns (uint256) {
        uint256 tge = total * r.tgeBps / BPS;
        uint256 start = uint256(r.settledAt) + r.cliff;
        if (block.timestamp <= start) return tge;
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= r.vestDuration) return total;
        return tge + (total - tge) * elapsed / r.vestDuration;
    }

    /// @dev Records tokens leaving the engine for `r` and caps the total at what the round brought in,
    ///      so no round can ever spend another round's tokens.
    function _tokensOut(Round storage r, uint256 amount) private {
        r.tokensOut += amount;
        require(r.tokensOut <= uint256(r.sellAmount) + r.tokenReserve, "token accounting");
    }

    /// @dev ceil(a × b / d). Rounds what a bidder pays, and bid-size checks, against the bidder (bug #8).
    function _mulDivUp(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        uint256 x = a * b;
        return x == 0 ? 0 : (x - 1) / d + 1;
    }
}
