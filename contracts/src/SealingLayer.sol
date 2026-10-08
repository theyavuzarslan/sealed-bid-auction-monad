// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {DepositLedger} from "./DepositLedger.sol";
import {MerkleProofLib} from "./lib/MerkleProofLib.sol";

/// @notice Commit/reveal for sealed bids, shared by every product.
/// @dev Preimage: keccak256(abi.encode(price, amount, salt, msg.sender)). All four fields are
///      load-bearing: without the salt a bid is brute-forceable; without msg.sender a commitment
///      can be replayed or its reveal front-run (AGENTS.md bugs #1, #2).
///      `note` is an encrypted bid backup for recovery (10-decisions.md #33). It is emitted, never stored.
abstract contract SealingLayer is DepositLedger {
    /// @notice Longest accepted encrypted bid backup, in bytes.
    uint256 public constant MAX_NOTE_LENGTH = 256;
    /// @notice Shortest commit window a round may have, in seconds. Monad timestamps have one-second
    ///         resolution over ~300 ms blocks; a window of a few seconds would let a creator open a round
    ///         nobody can realistically bid in.
    uint256 public constant MIN_COMMIT_WINDOW = 5 minutes;
    /// @notice Shortest reveal window a round may have, in seconds. Without a floor, a creator could
    ///         open a round with a reveal window too short for honest bidders, whose unrevealed
    ///         deposits would then be burned.
    uint256 public constant MIN_REVEAL_WINDOW = 5 minutes;
    /// @dev "No hint": `reveal` passes it to `_onReveal`. Equal to `UniformClearing.NONE` on purpose, so
    ///      the book treats it as "walk from the head". Keep the two equal.
    uint256 internal constant NO_HINT = type(uint256).max;

    struct Commitment {
        bytes32 hash; // zero = no commitment
        bool revealed;
    }

    /// @notice Each bidder's commitment per round.
    mapping(uint256 => mapping(address => Commitment)) public commitments;

    /// @notice `bidder` committed to `hash` in `roundId`, with an optional encrypted backup `note`.
    event Committed(uint256 indexed roundId, address indexed bidder, bytes32 hash, bytes note);
    /// @notice `bidder` revealed a valid bid in `roundId`.
    event Revealed(uint256 indexed roundId, address indexed bidder, uint96 price, uint96 amount);

    /// @notice Commit to a sealed bid, locking the round's uniform deposit (send exactly it as msg.value).
    /// @param roundId The round to bid in; must be in its commit window.
    /// @param hash    keccak256(abi.encode(price, amount, salt, msg.sender)); nonzero, one per bidder per round.
    /// @param proof   Merkle proof of msg.sender when the round has an allowlist; empty otherwise.
    /// @param note    Encrypted bid backup (optional, at most MAX_NOTE_LENGTH bytes).
    function commit(uint256 roundId, bytes32 hash, bytes32[] calldata proof, bytes calldata note)
        external
        payable
        nonReentrant
    {
        (uint256 deposit, uint256 commitEnd,, bytes32 allowlistRoot) = _sealTerms(roundId);
        require(block.timestamp < commitEnd, "commit window closed");
        require(msg.value == deposit, "wrong deposit");
        require(hash != bytes32(0), "empty hash");
        require(note.length <= MAX_NOTE_LENGTH, "note too long");
        if (allowlistRoot != bytes32(0)) {
            require(MerkleProofLib.verify(proof, allowlistRoot, MerkleProofLib.leafOf(msg.sender)), "not on allowlist");
        }
        Commitment storage c = commitments[roundId][msg.sender];
        require(c.hash == bytes32(0), "already committed");
        c.hash = hash;
        ledgers[roundId].commits += 1;
        _credit(roundId, deposit);
        emit Committed(roundId, msg.sender, hash, note);
    }

    /// @notice Reveal a committed bid during the reveal window, walking the price book from its head.
    /// @param roundId The round committed to.
    /// @param price   Price of the bid (product-specific unit, see `_onReveal`).
    /// @param amount  Amount of the bid (product-specific unit, see `_onReveal`).
    /// @param salt    The salt used in the commitment.
    function reveal(uint256 roundId, uint96 price, uint96 amount, bytes32 salt) external nonReentrant {
        _reveal(roundId, price, amount, salt, NO_HINT);
    }

    /// @notice `reveal` with a starting point in the price book, so the insert does not walk from the head.
    /// @dev An invalid or stale hint is ignored (the walk starts from the head), never a revert.
    /// @param roundId The round committed to.
    /// @param price   Price of the bid.
    /// @param amount  Amount of the bid.
    /// @param salt    The salt used in the commitment.
    /// @param hint    An existing price level above `price` (see `UniformClearing.findHint`).
    function revealWithHint(uint256 roundId, uint96 price, uint96 amount, bytes32 salt, uint256 hint)
        external
        nonReentrant
    {
        _reveal(roundId, price, amount, salt, hint);
    }

    function _depositOf(uint256 roundId) internal view override returns (uint256 deposit) {
        (deposit,,,) = _sealTerms(roundId);
    }

    function _revealEndOf(uint256 roundId) internal view override returns (uint256 revealEnd) {
        (,, revealEnd,) = _sealTerms(roundId);
    }

    /// @dev Must revert for unknown rounds.
    function _sealTerms(uint256 roundId)
        internal
        view
        virtual
        returns (uint256 deposit, uint256 commitEnd, uint256 revealEnd, bytes32 allowlistRoot);

    /// @dev Validates the bid and books it. A revert here rolls back the whole reveal.
    function _onReveal(uint256 roundId, address bidder, uint96 price, uint96 amount, uint256 hint) internal virtual;

    /// @dev Effects (revealed flag, counter) before `_onReveal`, which may make external calls.
    function _reveal(uint256 roundId, uint96 price, uint96 amount, bytes32 salt, uint256 hint) private {
        (, uint256 commitEnd, uint256 revealEnd,) = _sealTerms(roundId);
        require(block.timestamp >= commitEnd && block.timestamp < revealEnd, "reveal window closed");
        Commitment storage c = commitments[roundId][msg.sender];
        require(c.hash != bytes32(0) && !c.revealed, "no unrevealed commitment");
        require(keccak256(abi.encode(price, amount, salt, msg.sender)) == c.hash, "hash mismatch");
        c.revealed = true;
        ledgers[roundId].reveals += 1;
        _onReveal(roundId, msg.sender, price, amount, hint);
        emit Revealed(roundId, msg.sender, price, amount);
    }
}
