// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "../vendor/openzeppelin/token/ERC20/ERC20.sol";

/// @notice A plain launch token: fixed supply, 18 decimals, minted once to its creator.
/// @dev No owner, no mint, no burn hook, no fee, no pause, no blacklist: nothing a creator can use
///      against buyers after the launch. Standard OpenZeppelin v5.1.0 ERC20, unmodified.
contract LaunchToken is ERC20 {
    /// @param name_   Token name.
    /// @param symbol_ Token symbol.
    /// @param supply  Whole supply, in 18-decimal units, minted once.
    /// @param to      Receives the whole supply.
    constructor(string memory name_, string memory symbol_, uint256 supply, address to) ERC20(name_, symbol_) {
        _mint(to, supply);
    }
}

/// @notice Lets a creator make a token and launch it in the same session, the way a launchpad does.
///         The factory only creates tokens; the creator then approves the engine and opens the round
///         themselves, so the engine's creator (who receives proceeds) is always the person, never
///         this contract. Not on the money path: it never holds MON or tokens.
contract TokenFactory {
    /// @notice Longest accepted token name, in bytes.
    uint256 public constant MAX_NAME_BYTES = 32;
    /// @notice Longest accepted token symbol, in bytes.
    uint256 public constant MAX_SYMBOL_BYTES = 12;
    /// @notice Largest accepted supply.
    /// @dev Bids and supplies in the engine are uint96/uint128; a supply above uint96 could never sell out.
    uint256 public constant MAX_SUPPLY = type(uint96).max;

    /// @notice Whether `token` was created by this factory.
    mapping(address => bool) public isFactoryToken;
    /// @notice Every token created, in creation order.
    address[] public allTokens;

    /// @notice `creator` created `token` with its whole `supply` minted to them.
    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 supply);

    /// @notice Create a fixed-supply token and mint all of it to msg.sender.
    /// @param name   1 to MAX_NAME_BYTES bytes.
    /// @param symbol 1 to MAX_SYMBOL_BYTES bytes.
    /// @param supply 1 to MAX_SUPPLY, in 18-decimal units.
    /// @return token The new token.
    function create(string calldata name, string calldata symbol, uint256 supply) external returns (address token) {
        require(bytes(name).length != 0 && bytes(name).length <= MAX_NAME_BYTES, "bad name");
        require(bytes(symbol).length != 0 && bytes(symbol).length <= MAX_SYMBOL_BYTES, "bad symbol");
        require(supply != 0 && supply <= MAX_SUPPLY, "bad supply");
        token = address(new LaunchToken(name, symbol, supply, msg.sender));
        isFactoryToken[token] = true;
        allTokens.push(token);
        emit TokenCreated(token, msg.sender, name, symbol, supply);
    }

    /// @notice Number of tokens created (length of `allTokens`).
    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
