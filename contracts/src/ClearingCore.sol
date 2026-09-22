// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

/*
 * ClearingCore — sealed-bid uniform-clearing-price batch auction core.
 *
 * Forked from Gnosis EasyAuction (LGPL-3.0). Logic is kept identical:
 *   price ordering, volume accumulation to sellAmount, crossing bid sets
 *   uniform clearing price, partial fill at the marginal bid, multi-
 *   transaction settlement via precalculateSellAmountSum + settleAuction.
 *
 * Original: https://github.com/Gnosis-Auction/auction-contracts
 * License:  GNU Lesser General Public License v3.0 — see vendor/easyauction/LICENSE
 *
 * Changes vs upstream (Solidity 0.8.24):
 *   - Replaces SafeMath with checked arithmetic (0.8 built-ins).
 *   - Removes ERC20 transfers and Ownable/fee-admin — those belong to
 *     the deposit ledger / LP seeder per 03-architecture.md. ClearingCore
 *     is pure price-discovery + fill accounting. Fee logic is retained as
 *     a configurable stub (feeNumerator / FEE_DENOMINATOR) wired through
 *     constructor so callers can keep EasyAuction's 0-1.5% fee path without
 *     hard-coding an assumption.
 *   - AllowListVerifier removed; sealing layer enforces allowlist before
 *     calling placeSellOrders.
 *   - Token addresses are not stored; the caller (sealing layer) owns
 *     token custody. ClearingCore only orders bids and computes prices.
 *
 * Constructor parameters for unspecified items (12-open-questions.md):
 *   - minimumBiddingAmountPerOrder_ : global gas-DoS floor. Every bid's
 *     sellAmount must be > this value. Mandatory — not optional
 *     (AGENTS.md bug #6, 03-architecture.md inherited constraints).
 *   - feeNumerator_ / feeReceiver_  : EasyAuction fee path is unspecified
 *     for this engine; made configurable rather than guessed (Q1/Q9).
 *   - minFundingThreshold handling is per-round; default 0 means no
 *     threshold unless the round creator sets one.
 *
 * Invariants carried from EasyAuction:
 *   - Total bidding-token volume < 2^96 or the auction becomes unsettleable.
 *   - Prices are uint96 fractions (buyAmount / sellAmount).
 *   - Settlement may span multiple transactions.
 */

// ─── SafeCast (ported from vendor/easyauction/contracts/libraries/SafeCast.sol) ─
library SafeCast {
    function toUint96(uint256 value) internal pure returns (uint96) {
        require(value < 2**96, "SafeCast: value doesn't fit in 96 bits");
        return uint96(value);
    }
    function toUint64(uint256 value) internal pure returns (uint64) {
        require(value < 2**64, "SafeCast: value doesn't fit in 64 bits");
        return uint64(value);
    }
}

// ─── IdToAddressBiMap (ported from vendor/easyauction/contracts/libraries/IdToAddressBiMap.sol) ─
library IdToAddressBiMap {
    struct Data {
        mapping(uint64 => address) idToAddress;
        mapping(address => uint64) addressToId;
    }
    function hasId(Data storage self, uint64 id) internal view returns (bool) {
        return self.idToAddress[id + 1] != address(0);
    }
    function hasAddress(Data storage self, address addr) internal view returns (bool) {
        return self.addressToId[addr] != 0;
    }
    function getAddressAt(Data storage self, uint64 id) internal view returns (address) {
        require(hasId(self, id), "Must have ID to get Address");
        return self.idToAddress[id + 1];
    }
    function getId(Data storage self, address addr) internal view returns (uint64) {
        require(hasAddress(self, addr), "Must have Address to get ID");
        return self.addressToId[addr] - 1;
    }
    function insert(Data storage self, uint64 id, address addr) internal returns (bool) {
        require(addr != address(0), "Cannot insert zero address");
        require(id != type(uint64).max, "Cannot insert max uint64");
        if (self.addressToId[addr] != 0 || self.idToAddress[id + 1] != address(0)) {
            return false;
        }
        self.idToAddress[id + 1] = addr;
        self.addressToId[addr] = id + 1;
        return true;
    }
}

// ─── IterableOrderedOrderSet (ported from vendor/easyauction/contracts/libraries/IterableOrderedOrderSet.sol) ─
// Solidity 0.8 port: SafeMath removed, checked arithmetic is native.
library IterableOrderedOrderSet {
    bytes32 internal constant QUEUE_START = 0x0000000000000000000000000000000000000000000000000000000000000001;
    bytes32 internal constant QUEUE_END   = 0xffffffffffffffffffffffffffffffffffffffff000000000000000000000001;

    struct Data {
        mapping(bytes32 => bytes32) nextMap;
        mapping(bytes32 => bytes32) prevMap;
    }
    struct Order {
        uint64 owner;
        uint96 buyAmount;
        uint96 sellAmount;
    }

    function initializeEmptyList(Data storage self) internal {
        self.nextMap[QUEUE_START] = QUEUE_END;
        self.prevMap[QUEUE_END] = QUEUE_START;
    }
    function isEmpty(Data storage self) internal view returns (bool) {
        return self.nextMap[QUEUE_START] == QUEUE_END;
    }
    function insert(Data storage self, bytes32 elementToInsert, bytes32 elementBeforeNewOne) internal returns (bool) {
        (, , uint96 denominator) = decodeOrder(elementToInsert);
        require(denominator != uint96(0), "Inserting zero is not supported");
        require(elementToInsert != QUEUE_START && elementToInsert != QUEUE_END, "Inserting element is not valid");
        if (contains(self, elementToInsert)) return false;
        if (elementBeforeNewOne != QUEUE_START && self.prevMap[elementBeforeNewOne] == bytes32(0)) return false;
        if (!smallerThan(elementBeforeNewOne, elementToInsert)) return false;
        while (self.nextMap[elementBeforeNewOne] == bytes32(0)) {
            elementBeforeNewOne = self.prevMap[elementBeforeNewOne];
        }
        bytes32 previous;
        bytes32 current = elementBeforeNewOne;
        do {
            previous = current;
            current = self.nextMap[current];
        } while (smallerThan(current, elementToInsert));
        self.nextMap[previous] = elementToInsert;
        self.prevMap[current] = elementToInsert;
        self.prevMap[elementToInsert] = previous;
        self.nextMap[elementToInsert] = current;
        return true;
    }
    function removeKeepHistory(Data storage self, bytes32 elementToRemove) internal returns (bool) {
        if (!contains(self, elementToRemove)) return false;
        bytes32 previousElement = self.prevMap[elementToRemove];
        bytes32 nextElement = self.nextMap[elementToRemove];
        self.nextMap[previousElement] = nextElement;
        self.prevMap[nextElement] = previousElement;
        self.nextMap[elementToRemove] = bytes32(0);
        return true;
    }
    function remove(Data storage self, bytes32 elementToRemove) internal returns (bool) {
        bool result = removeKeepHistory(self, elementToRemove);
        if (result) self.prevMap[elementToRemove] = bytes32(0);
        return result;
    }
    function contains(Data storage self, bytes32 value) internal view returns (bool) {
        if (value == QUEUE_START) return false;
        return self.nextMap[value] != bytes32(0);
    }
    // Orders are ordered by: 1) price buy/sell, 2) buyAmount tie-break, 3) userId
    function smallerThan(bytes32 orderLeft, bytes32 orderRight) internal pure returns (bool) {
        (uint64 userIdLeft, uint96 priceNumeratorLeft, uint96 priceDenominatorLeft) = decodeOrder(orderLeft);
        (uint64 userIdRight, uint96 priceNumeratorRight, uint96 priceDenominatorRight) = decodeOrder(orderRight);
        if (uint256(priceNumeratorLeft) * uint256(priceDenominatorRight) < uint256(priceNumeratorRight) * uint256(priceDenominatorLeft)) return true;
        if (uint256(priceNumeratorLeft) * uint256(priceDenominatorRight) > uint256(priceNumeratorRight) * uint256(priceDenominatorLeft)) return false;
        if (priceNumeratorLeft < priceNumeratorRight) return true;
        if (priceNumeratorLeft > priceNumeratorRight) return false;
        require(userIdLeft != userIdRight, "user is not allowed to place same order twice");
        if (userIdLeft < userIdRight) return true;
        return false;
    }
    function first(Data storage self) internal view returns (bytes32) {
        require(!isEmpty(self), "Trying to get first from empty set");
        return self.nextMap[QUEUE_START];
    }
    function next(Data storage self, bytes32 value) internal view returns (bytes32) {
        require(value != QUEUE_END, "Trying to get next of last element");
        bytes32 nextElement = self.nextMap[value];
        require(nextElement != bytes32(0), "Trying to get next of non-existent element");
        return nextElement;
    }
    function decodeOrder(bytes32 _orderData) internal pure returns (uint64 userId, uint96 buyAmount, uint96 sellAmount) {
        userId = uint64(uint256(_orderData) >> 192);
        buyAmount = uint96(uint256(_orderData) >> 96);
        sellAmount = uint96(uint256(_orderData));
    }
    function encodeOrder(uint64 userId, uint96 buyAmount, uint96 sellAmount) internal pure returns (bytes32) {
        return bytes32((uint256(userId) << 192) + (uint256(buyAmount) << 96) + uint256(sellAmount));
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/// @title ClearingCore
/// @notice Uniform-clearing-price batch auction clearing loop forked from EasyAuction.
/// @dev Round = one commit->reveal->clear->settle cycle (AGENTS.md terminology).
contract ClearingCore {
    using SafeCast for uint256;
    using IterableOrderedOrderSet for IterableOrderedOrderSet.Data;
    using IterableOrderedOrderSet for bytes32;
    using IdToAddressBiMap for IdToAddressBiMap.Data;

    // ─── Events ──────────────────────────────────────────────────────────
    event NewSellOrder(uint256 indexed roundId, uint64 indexed userId, uint96 buyAmount, uint96 sellAmount);
    event CancellationSellOrder(uint256 indexed roundId, uint64 indexed userId, uint96 buyAmount, uint96 sellAmount);
    event ClaimedFromOrder(uint256 indexed roundId, uint64 indexed userId, uint96 buyAmount, uint96 sellAmount);
    event NewUser(uint64 indexed userId, address indexed userAddress);
    event NewRound(
        uint256 indexed roundId,
        uint64 indexed userId,
        uint96 auctionedSellAmount,
        uint96 minBuyAmount,
        uint256 minimumBiddingAmountPerOrder,
        uint256 minFundingThreshold
    );
    event RoundCleared(uint256 indexed roundId, uint96 soldAuctioningTokens, uint96 soldBiddingTokens, bytes32 clearingPriceOrder);
    event UserRegistration(address indexed user, uint64 userId);

    // ─── Types ───────────────────────────────────────────────────────────
    struct RoundData {
        uint96 auctionedSellAmount;       // total sellAmount offered (fullAuctionedAmount)
        uint96 minBuyAmount;              // minimum buyAmount at initial price (minAuctionedBuyAmount)
        uint256 minimumBiddingAmountPerOrder; // gas-DoS floor for this round
        uint256 interimSumBidAmount;      // accumulated sellAmount for multi-tx settlement
        bytes32 interimOrder;             // last order included in interim sum
        bytes32 clearingPriceOrder;       // set at settlement; bytes32(0) means not yet settled
        uint96 volumeClearingPriceOrder;  // partial fill amount at marginal bid
        bool minFundingThresholdNotReached;
        uint256 minFundingThreshold;
        bool isAtomicClosureAllowed;
        uint256 feeNumerator;
        bool exists;
    }

    // ─── Storage ─────────────────────────────────────────────────────────
    mapping(uint256 => IterableOrderedOrderSet.Data) internal sellOrders;
    mapping(uint256 => RoundData) public roundData;
    IdToAddressBiMap.Data private registeredUsers;
    uint64 public numUsers;
    uint256 public roundCounter;

    uint256 public immutable minimumBiddingAmountPerOrderFloor; // global floor (constructor param)
    uint256 public feeNumerator;
    uint256 public constant FEE_DENOMINATOR = 1000;
    uint64 public feeReceiverUserId;

    // ─── Modifiers ───────────────────────────────────────────────────────
    modifier roundExists(uint256 roundId) {
        require(roundData[roundId].exists, "round does not exist");
        _;
    }
    modifier atStageSettlement(uint256 roundId) {
        // In EasyAuction this is "after auctionEndDate and not yet cleared".
        // ClearingCore is time-agnostic; the sealing layer enforces commit/reveal windows.
        // We only require the round exists and is not yet cleared.
        require(roundData[roundId].exists, "round does not exist");
        require(roundData[roundId].clearingPriceOrder == bytes32(0), "round already settled");
        _;
    }
    modifier atStageFinished(uint256 roundId) {
        require(roundData[roundId].clearingPriceOrder != bytes32(0), "round not yet settled");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────
    /// @param minimumBiddingAmountPerOrder_ Global gas-DoS floor; every bid sellAmount must be > this.
    /// @param feeNumerator_ Initial fee in FEE_DENOMINATOR units (0 = no fee, 15 = 1.5% max like EasyAuction).
    /// @param feeReceiver_ Address that receives fees (userId 1 is registered for it if needed).
    constructor(uint256 minimumBiddingAmountPerOrder_, uint256 feeNumerator_, address feeReceiver_) {
        require(minimumBiddingAmountPerOrder_ > 0, "minimumBiddingAmountPerOrder is not allowed to be zero");
        require(feeNumerator_ <= 15, "Fee is not allowed to be set higher than 1.5%");
        minimumBiddingAmountPerOrderFloor = minimumBiddingAmountPerOrder_;
        feeNumerator = feeNumerator_;
        // Register fee receiver as user 1 if provided, mirroring EasyAuction's feeReceiverUserId = 1 default.
        if (feeReceiver_ != address(0)) {
            feeReceiverUserId = getUserId(feeReceiver_);
        } else {
            feeReceiverUserId = 1;
        }
    }

    // ─── Round lifecycle ─────────────────────────────────────────────────
    /// @notice Create a new round (auction). Mirrors EasyAuction.initiateAuction without token transfers.
    /// @dev Token custody is handled by the sealing layer / deposit ledger; this only registers clearing params.
    function createRound(
        uint96 _auctionedSellAmount,
        uint96 _minBuyAmount,
        uint256 _minimumBiddingAmountPerOrder,
        uint256 _minFundingThreshold,
        bool _isAtomicClosureAllowed
    ) external returns (uint256) {
        require(_auctionedSellAmount > 0, "cannot auction zero tokens");
        require(_minBuyAmount > 0, "tokens cannot be auctioned for free");
        require(_minimumBiddingAmountPerOrder > 0, "minimumBiddingAmountPerOrder is not allowed to be zero");
        // Enforce global floor — the gas-DoS defence is not configurable per-round below this.
        require(
            _minimumBiddingAmountPerOrder >= minimumBiddingAmountPerOrderFloor,
            "minimumBiddingAmountPerOrder below global floor"
        );
        // Enforce uint96 invariant on sellAmount (EasyAuction: < 2^96).
        require(_auctionedSellAmount < 2**96 && _minBuyAmount < 2**96, "amount exceeds uint96");

        roundCounter += 1;
        uint256 roundId = roundCounter;
        sellOrders[roundId].initializeEmptyList();
        uint64 userId = getUserId(msg.sender);

        // Encode initial auction order the same way EasyAuction does: (userId, minBuyAmount, auctionedSellAmount)
        // Stored implicitly via RoundData fields rather than a bytes32 slot, but semantically identical.
        roundData[roundId] = RoundData({
            auctionedSellAmount: _auctionedSellAmount,
            minBuyAmount: _minBuyAmount,
            minimumBiddingAmountPerOrder: _minimumBiddingAmountPerOrder,
            interimSumBidAmount: 0,
            interimOrder: IterableOrderedOrderSet.QUEUE_START,
            clearingPriceOrder: bytes32(0),
            volumeClearingPriceOrder: 0,
            minFundingThresholdNotReached: false,
            minFundingThreshold: _minFundingThreshold,
            isAtomicClosureAllowed: _isAtomicClosureAllowed,
            feeNumerator: feeNumerator,
            exists: true
        });

        emit NewRound(roundId, userId, _auctionedSellAmount, _minBuyAmount, _minimumBiddingAmountPerOrder, _minFundingThreshold);
        return roundId;
    }

    // ─── Order placement ─────────────────────────────────────────────────
    /// @notice Place one or more sell orders (bids) into the ordered set.
    /// @dev Mirrors EasyAuction.placeSellOrders / _placeSellOrders without token transfers or allowlist.
    ///      Sealing layer must have already verified commitments and collected deposits.
    function placeSellOrders(
        uint256 roundId,
        uint96[] memory _minBuyAmounts,
        uint96[] memory _sellAmounts,
        bytes32[] memory _prevSellOrders
    ) external roundExists(roundId) atStageSettlement(roundId) returns (uint64 userId) {
        return _placeSellOrders(roundId, _minBuyAmounts, _sellAmounts, _prevSellOrders, msg.sender);
    }

    function placeSellOrdersOnBehalf(
        uint256 roundId,
        uint96[] memory _minBuyAmounts,
        uint96[] memory _sellAmounts,
        bytes32[] memory _prevSellOrders,
        address orderSubmitter
    ) external roundExists(roundId) atStageSettlement(roundId) returns (uint64 userId) {
        return _placeSellOrders(roundId, _minBuyAmounts, _sellAmounts, _prevSellOrders, orderSubmitter);
    }

    function _placeSellOrders(
        uint256 roundId,
        uint96[] memory _minBuyAmounts,
        uint96[] memory _sellAmounts,
        bytes32[] memory _prevSellOrders,
        address orderSubmitter
    ) internal returns (uint64 userId) {
        require(_minBuyAmounts.length == _sellAmounts.length, "array length mismatch");
        require(_minBuyAmounts.length == _prevSellOrders.length, "array length mismatch");

        RoundData storage rd = roundData[roundId];

        // Enforce limit price better than the initial minimal offer, same check as EasyAuction:
        //   minBuyAmount[i] * minBuyAmount_initial < auctionedSellAmount_initial * sellAmount[i]
        // This rejects bids that do not improve on the reserve price.
        for (uint256 i = 0; i < _minBuyAmounts.length; i++) {
            // OFF-BY-ONE RISK (price comparison): strict < means a bid whose price exactly equals
            // the reserve price is rejected. Changing to <= would accept reserve-price bids and shift
            // the demand curve by one tick, affecting which order becomes marginal.
            require(
                uint256(_minBuyAmounts[i]) * uint256(rd.minBuyAmount) < uint256(rd.auctionedSellAmount) * uint256(_sellAmounts[i]),
                "limit price not better than minimal offer"
            );
        }

        userId = getUserId(orderSubmitter);
        uint256 minimumBiddingAmountPerOrder = rd.minimumBiddingAmountPerOrder;

        for (uint256 i = 0; i < _minBuyAmounts.length; i++) {
            require(_minBuyAmounts[i] > 0, "_minBuyAmounts must be greater than 0");
            // MANDATORY GAS-DOS DEFENCE: keep EasyAuction's minimum bid size check.
            // EasyAuction uses strict > (not >=). Off-by-one here: using >= would admit
            // dust orders of exactly the floor value, re-opening the gas-DoS the floor exists to prevent.
            require(_sellAmounts[i] > minimumBiddingAmountPerOrder, "order too small");
            // Total volume invariant: each sellAmount < 2^96 is already checked by uint96 type,
            // but cumulative sum must also stay < 2^96 for settleability.
            if (
                sellOrders[roundId].insert(
                    IterableOrderedOrderSet.encodeOrder(userId, _minBuyAmounts[i], _sellAmounts[i]),
                    _prevSellOrders[i]
                )
            ) {
                emit NewSellOrder(roundId, userId, _minBuyAmounts[i], _sellAmounts[i]);
            }
        }
    }

    function cancelSellOrders(uint256 roundId, bytes32[] memory _sellOrders) external roundExists(roundId) atStageSettlement(roundId) {
        uint64 userId = getUserId(msg.sender);
        for (uint256 i = 0; i < _sellOrders.length; i++) {
            bool success = sellOrders[roundId].removeKeepHistory(_sellOrders[i]);
            if (success) {
                (uint64 userIdOfIter, uint96 buyAmountOfIter, uint96 sellAmountOfIter) = _sellOrders[i].decodeOrder();
                require(userIdOfIter == userId, "Only the user can cancel his orders");
                emit CancellationSellOrder(roundId, userId, buyAmountOfIter, sellAmountOfIter);
            }
        }
    }

    // ─── Multi-transaction settlement: precalculate ───────────────────────
    /// @notice Advance the clearing loop by `iterationSteps` orders without finalizing.
    /// @dev Identical to EasyAuction.precalculateSellAmountSum. Allows settlement to span multiple txs.
    function precalculateSellAmountSum(uint256 roundId, uint256 iterationSteps) external atStageSettlement(roundId) {
        RoundData storage rd = roundData[roundId];
        uint96 auctioneerSellAmount = rd.auctionedSellAmount;
        uint256 sumBidAmount = rd.interimSumBidAmount;
        bytes32 iterOrder = rd.interimOrder;

        for (uint256 i = 0; i < iterationSteps; i++) {
            iterOrder = sellOrders[roundId].next(iterOrder);
            (, , uint96 _sellAmountOfIter) = iterOrder.decodeOrder();
            sumBidAmount += _sellAmountOfIter;
            // OFF-BY-ONE RISK (volume accumulation): sumBidAmount is the sum of sellAmounts of all
            // orders visited so far (including iterOrder). If the increment were placed after the
            // price check instead of before, the crossing order would be off by one position.
        }

        require(iterOrder != IterableOrderedOrderSet.QUEUE_END, "reached end of order list");

        // OFF-BY-ONE RISK (too-many-orders guard): this require ensures precalculation has not
        // summed past the crossing point. The strict < mirrors the settle loop's while-condition.
        // Using <= here would allow one extra order to be included, causing settleAuction to start
        // past the marginal bid and under-allocate by one order's volume.
        (, uint96 buyAmountOfIter, uint96 sellAmountOfIter) = iterOrder.decodeOrder();
        require(
            sumBidAmount * uint256(buyAmountOfIter) < uint256(auctioneerSellAmount) * uint256(sellAmountOfIter),
            "too many orders summed up"
        );

        rd.interimSumBidAmount = sumBidAmount;
        rd.interimOrder = iterOrder;
    }

    // ─── Settlement: find clearing price ─────────────────────────────────
    /// @notice Find the crossing bid, set the uniform clearing price, and mark the round settled.
    /// @dev Port of EasyAuction.settleAuction — keep logic identical. See inline OFF-BY-ONE comments.
    function settleAuction(uint256 roundId) external atStageSettlement(roundId) returns (bytes32 clearingOrder) {
        return _settleCore(roundId);
    }

    function _settleAuction(uint256 roundId) internal returns (bytes32 clearingOrder) {
        // Internal helper extracted so settleAuctionAtomically can call it without external this-call.
        RoundData storage rd = roundData[roundId];
        require(rd.exists, "round does not exist");
        require(rd.clearingPriceOrder == bytes32(0), "round already settled");
        // Inline the same logic as settleAuction external entrypoint — delegate to avoid code duplication
        // by having the external wrapper call this internal. For now the external function below
        // contains the full implementation and this internal is the atomic path's target.
        // To keep a single source of truth, atomic path will replicate the check and call the
        // external via low-level to preserve modifier semantics; instead we just call the shared helper
        // defined below. See _settleCore below.
        clearingOrder = _settleCore(roundId);
    }

    function _settleCore(uint256 roundId) internal returns (bytes32 clearingOrder) {
        RoundData storage rd = roundData[roundId];
        uint96 minAuctionedBuyAmount = rd.minBuyAmount;
        uint96 fullAuctionedAmount = rd.auctionedSellAmount;
        uint256 currentBidSum = rd.interimSumBidAmount;
        bytes32 currentOrder = rd.interimOrder;
        uint256 buyAmountOfIter;
        uint256 sellAmountOfIter;
        uint96 fillVolumeOfAuctioneerOrder = fullAuctionedAmount;
        IterableOrderedOrderSet.Data storage orders = sellOrders[roundId];
        // OFF-BY-ONE RISK (loop condition): strict < means price equality stops the loop.
        // Using <= would consume one extra order and over-allocate.
        do {
            bytes32 nextOrder = orders.next(currentOrder);
            if (nextOrder == IterableOrderedOrderSet.QUEUE_END) break;
            currentOrder = nextOrder;
            (, buyAmountOfIter, sellAmountOfIter) = currentOrder.decodeOrder();
            currentBidSum += sellAmountOfIter;
        } while (currentBidSum * buyAmountOfIter < uint256(fullAuctionedAmount) * uint256(sellAmountOfIter));
        // OFF-BY-ONE RISK (clearing-price branch): >= detects fully filled. > would miss exact equality.
        if (currentBidSum > 0 && currentBidSum * buyAmountOfIter >= uint256(fullAuctionedAmount) * uint256(sellAmountOfIter)) {
            // OFF-BY-ONE RISK (uncoveredBids): division truncates DOWN; favors auctioneer. Rounding up would over-allocate (bug #8).
            uint256 uncoveredBids = currentBidSum - (uint256(fullAuctionedAmount) * uint256(sellAmountOfIter) / buyAmountOfIter);
            // OFF-BY-ONE RISK (branch [13] vs [14]): >= decides partial-fill vs synthetic price.
            // Changing to > would mis-route the boundary bid.
            if (sellAmountOfIter >= uncoveredBids) {
                // [13] Partial fill of marginal order — highest-risk line (bug #4).
                // OFF-BY-ONE RISK: sellAmountClearingOrder = sellIter - uncoveredBids is off by 1 if uncoveredBids is off by 1.
                uint256 sellAmountClearingOrder = sellAmountOfIter - uncoveredBids;
                // OFF-BY-ONE RISK (SafeCast): must fit in uint96; off-by-one to 2^96 bricks settlement.
                rd.volumeClearingPriceOrder = sellAmountClearingOrder.toUint96();
                // OFF-BY-ONE RISK: forgetting this subtraction over-reports sold volume by uncoveredBids.
                currentBidSum -= uncoveredBids;
                clearingOrder = currentOrder;
            } else {
                // [14] Synthetic price strictly between marginal and previous order.
                // OFF-BY-ONE RISK: must subtract sellAmountOfIter first; otherwise price too low.
                currentBidSum -= sellAmountOfIter;
                clearingOrder = IterableOrderedOrderSet.encodeOrder(0, fullAuctionedAmount, currentBidSum.toUint96());
            }
        } else {
            // OFF-BY-ONE RISK ([15] vs [16]): > vs >= decides fully vs partially filled at reserve.
            if (currentBidSum > minAuctionedBuyAmount) {
                // [15] Synthetic price higher than last order.
                clearingOrder = IterableOrderedOrderSet.encodeOrder(0, fullAuctionedAmount, currentBidSum.toUint96());
            } else {
                // [16] Partially filled at reserve price.
                clearingOrder = IterableOrderedOrderSet.encodeOrder(0, fullAuctionedAmount, minAuctionedBuyAmount);
                // OFF-BY-ONE RISK: division truncates DOWN; rounding up would be insolvent (bug #4).
                fillVolumeOfAuctioneerOrder = (currentBidSum * uint256(fullAuctionedAmount) / uint256(minAuctionedBuyAmount)).toUint96();
            }
        }
        rd.clearingPriceOrder = clearingOrder;
        if (rd.minFundingThreshold > currentBidSum) rd.minFundingThresholdNotReached = true;
        emit RoundCleared(roundId, fillVolumeOfAuctioneerOrder, uint96(currentBidSum), clearingOrder);
        rd.interimOrder = bytes32(0);
        rd.interimSumBidAmount = 0;
    }

    // ─── Atomic closure (optional) ───────────────────────────────────────
    function settleAuctionAtomically(
        uint256 roundId,
        uint96[] memory _minBuyAmount,
        uint96[] memory _sellAmount,
        bytes32[] memory _prevSellOrder
    ) external atStageSettlement(roundId) {
        RoundData storage rd = roundData[roundId];
        require(rd.isAtomicClosureAllowed, "not allowed to settle auction atomically");
        require(_minBuyAmount.length == 1 && _sellAmount.length == 1, "Only one order can be placed atomically");
        uint64 userId = getUserId(msg.sender);
        // OFF-BY-ONE RISK (atomic ordering): interimOrder must be smallerThan the new order,
        // otherwise precalculation is already past this price point and atomic insertion would
        // be out-of-order, corrupting the sorted list.
        require(
            rd.interimOrder.smallerThan(IterableOrderedOrderSet.encodeOrder(userId, _minBuyAmount[0], _sellAmount[0])),
            "precalculateSellAmountSum is already too advanced"
        );
        _placeSellOrders(roundId, _minBuyAmount, _sellAmount, _prevSellOrder, msg.sender);
        _settleCore(roundId);
    }

    // ─── Claims ──────────────────────────────────────────────────────────
    /// @notice Claim fills/refunds for a set of orders belonging to one user.
    /// @dev Mirrors EasyAuction.claimFromParticipantOrder. Reentrancy-safe by
    ///      removing orders before computing amounts (checks-effects-interactions).
    ///      In this custody-free core, "amounts" are returned, not transferred;
    ///      the deposit ledger interprets them to move tokens.
    function claimFromParticipantOrder(
        uint256 roundId,
        bytes32[] memory orders
    )
        external
        atStageFinished(roundId)
        returns (uint256 sumAuctioningTokenAmount, uint256 sumBiddingTokenAmount)
    {
        require(orders.length > 0, "no orders to claim");
        for (uint256 i = 0; i < orders.length; i++) {
            require(sellOrders[roundId].remove(orders[i]), "order is no longer claimable");
        }
        RoundData memory rd = roundData[roundId];
        (, uint96 priceNumerator, uint96 priceDenominator) = rd.clearingPriceOrder.decodeOrder();
        (uint64 userId, , ) = orders[0].decodeOrder();
        bool minFundingThresholdNotReached = rd.minFundingThresholdNotReached;

        for (uint256 i = 0; i < orders.length; i++) {
            (uint64 userIdOrder, uint96 buyAmount, uint96 sellAmount) = orders[i].decodeOrder();
            require(userIdOrder == userId, "only allowed to claim for same user");
            if (minFundingThresholdNotReached) {
                // [10] Threshold not met — full refund of bidding tokens.
                sumBiddingTokenAmount += sellAmount;
            } else {
                if (orders[i] == rd.clearingPriceOrder) {
                    // [25] Marginal order — partial fill.
                    // OFF-BY-ONE RISK (marginal fill): volumeClearingPriceOrder is the sellAmount
                    // portion that actually clears. Auctioning tokens = volume * priceNumerator / priceDenominator.
                    // Division truncates DOWN; truncating here under-pays the bidder by <1 unit of
                    // auctioning token, which is safe (dust stays). Rounding up would over-pay and
                    // could exceed the auctioned supply (bug #4 / #8).
                    sumAuctioningTokenAmount += uint256(rd.volumeClearingPriceOrder) * uint256(priceNumerator) / uint256(priceDenominator);
                    // OFF-BY-ONE RISK (refund remainder): sellAmount - volumeClearingPriceOrder must exactly
                    // account for the uncovered portion. If volume is off by 1, the refund is off by 1.
                    sumBiddingTokenAmount += uint256(sellAmount) - uint256(rd.volumeClearingPriceOrder);
                } else {
                    if (orders[i].smallerThan(rd.clearingPriceOrder)) {
                        // [17] Fully clearing order — price is clearingPriceOrder's price.
                        // OFF-BY-ONE RISK (winner fill): sellAmount * priceNumerator / priceDenominator
                        // truncates DOWN per order. Summed truncation across many winners is bounded by
                        // numberOfWinners units of dust. Rounding up would let summed fills exceed sellAmount.
                        sumAuctioningTokenAmount += uint256(sellAmount) * uint256(priceNumerator) / uint256(priceDenominator);
                    } else {
                        // [24] Non-clearing order — full refund.
                        sumBiddingTokenAmount += sellAmount;
                    }
                }
            }
            emit ClaimedFromOrder(roundId, userId, buyAmount, sellAmount);
        }
        // Token transfers are NOT done here — the deposit ledger / caller handles them.
        // This matches the "clearing core is price discovery only" split in 03-architecture.md.
    }

    // ─── Views ───────────────────────────────────────────────────────────
    function containsOrder(uint256 roundId, bytes32 order) external view returns (bool) {
        return sellOrders[roundId].contains(order);
    }
    function getSecondsRemainingInBatch(uint256, uint256) external pure returns (uint256) {
        // Time windows are enforced by the sealing layer; clearing core is time-agnostic.
        // Kept for API symmetry with EasyAuction; always returns 0.
        return 0;
    }
    function getClearingPrice(uint256 roundId) external view returns (uint96 numerator, uint96 denominator, uint96 partialFillVolume) {
        RoundData memory rd = roundData[roundId];
        require(rd.clearingPriceOrder != bytes32(0), "not yet settled");
        (, numerator, denominator) = rd.clearingPriceOrder.decodeOrder();
        partialFillVolume = rd.volumeClearingPriceOrder;
    }

    // ─── User registry ───────────────────────────────────────────────────
    function registerUser(address user) public returns (uint64 userId) {
        numUsers += 1;
        uint64 newId = SafeCast.toUint64(numUsers);
        require(registeredUsers.insert(newId, user), "User already registered");
        userId = newId;
        emit UserRegistration(user, userId);
    }
    function getUserId(address user) public returns (uint64 userId) {
        if (registeredUsers.hasAddress(user)) {
            userId = registeredUsers.getId(user);
        } else {
            userId = registerUser(user);
            emit NewUser(userId, user);
        }
    }

    // ─── Fee admin (mirrors EasyAuction.setFeeParameters, no Ownable) ───
    // Unspecified who governs fees (12-open-questions.md Q1/Q9); for now anyone can
    // set fees before rounds are created. A production deployment should gate this
    // behind an owner or governance contract — left as constructor + open setter
    // to avoid guessing the access control model.
    function setFeeParameters(uint256 newFeeNumerator, address newFeeReceiver) external {
        // TODO: not specified — who may call setFeeParameters? EasyAuction uses onlyOwner;
        // this engine has no owner yet. Currently open; gate before mainnet.
        require(newFeeNumerator <= 15, "Fee is not allowed to be set higher than 1.5%");
        feeReceiverUserId = getUserId(newFeeReceiver);
        feeNumerator = newFeeNumerator;
    }
}
