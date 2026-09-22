// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

/// @notice Verifier compatible with OpenZeppelin's StandardMerkleTree (sorted-pair hashing).
///         Leaf for an allowlisted address: keccak256(bytes.concat(keccak256(abi.encode(addr)))).
library MerkleProofLib {
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encode(h, p)) : keccak256(abi.encode(p, h));
        }
        return h == root;
    }

    function leafOf(address account) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account))));
    }
}
