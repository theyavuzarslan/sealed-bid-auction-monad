// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.28;

import {ERC20} from "../vendor/openzeppelin/token/ERC20/ERC20.sol";

/// @notice A plain launch token: fixed supply, 18 decimals, minted once to its creator.
/// @dev No owner, no mint, no burn hook, no fee, no pause, no blacklist: nothing a creator can use
///      against buyers after the launch. Standard OpenZeppelin v5.1.0 ERC20, unmodified.
contract LaunchToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address to) ERC20(name_, symbol_) {
        _mint(to, supply);
    }
}

/// @notice Lets a creator make a token and launch it in the same session, the way a launchpad does.
///         The factory only creates tokens; the creator then approves the engine and opens the round
///         themselves, so the engine's creator (who receives proceeds) is always the person, never
///         this contract. Not on the money path: it never holds MON or tokens.
contract TokenFactory {
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_SYMBOL_BYTES = 12;
    /// Bids and supplies in the engine are uint96/uint128; a supply above uint96 could never sell out.
    uint256 public constant MAX_SUPPLY = type(uint96).max;

    mapping(address => bool) public isFactoryToken;
    address[] public allTokens;

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 supply);

    function create(string calldata name, string calldata symbol, uint256 supply) external returns (address token) {
        require(bytes(name).length != 0 && bytes(name).length <= MAX_NAME_BYTES, "bad name");
        require(bytes(symbol).length != 0 && bytes(symbol).length <= MAX_SYMBOL_BYTES, "bad symbol");
        require(supply != 0 && supply <= MAX_SUPPLY, "bad supply");
        token = address(new LaunchToken(name, symbol, supply, msg.sender));
        isFactoryToken[token] = true;
        allTokens.push(token);
        emit TokenCreated(token, msg.sender, name, symbol, supply);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
