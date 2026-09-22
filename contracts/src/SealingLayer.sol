// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {DepositLedger} from "./DepositLedger.sol";
import {MerkleProofLib} from "./lib/MerkleProofLib.sol";

/// @notice Commit/reveal for sealed bids, shared by every product.
/// @dev Preimage: keccak256(abi.encode(price, amount, salt, msg.sender)). All four fields are
///      load-bearing: without the salt a bid is brute-forceable; without msg.sender a commitment
///      can be replayed or its reveal front-run (AGENTS.md bugs #1, #2).
///      `note` is an encrypted bid backup for recovery (10-decisions.md #33). It is emitted, never stored.
abstract contract SealingLayer is DepositLedger {
    uint256 public constant MAX_NOTE_LENGTH = 256;
    uint256 internal constant NO_HINT = type(uint256).max;

    struct Commitment {
        bytes32 hash;
        bool revealed;
    }

    mapping(uint256 => mapping(address => Commitment)) public commitments;

    event Committed(uint256 indexed roundId, address indexed bidder, bytes32 hash, bytes note);
    event Revealed(uint256 indexed roundId, address indexed bidder, uint96 price, uint96 amount);

    /// @param proof Merkle proof of msg.sender when the round has an allowlist; empty otherwise.
    /// @param note  Encrypted bid backup (optional, at most MAX_NOTE_LENGTH bytes).
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

    function reveal(uint256 roundId, uint96 price, uint96 amount, bytes32 salt) external nonReentrant {
        _reveal(roundId, price, amount, salt, NO_HINT);
    }

    /// @param hint An existing price level above `price`, to skip walking the book (see findHint).
    function revealWithHint(uint256 roundId, uint96 price, uint96 amount, bytes32 salt, uint256 hint)
        external
        nonReentrant
    {
        _reveal(roundId, price, amount, salt, hint);
    }

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
}
