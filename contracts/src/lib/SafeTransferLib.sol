// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice ERC-20 and native transfers that tolerate tokens returning no value, and reject
///         calls to addresses with no code (a silent "success" from a non-contract).
library SafeTransferLib {
    /// @dev ERC-20 `transfer(address,uint256)`.
    bytes4 private constant TRANSFER = 0xa9059cbb;
    /// @dev ERC-20 `transferFrom(address,address,uint256)`.
    bytes4 private constant TRANSFER_FROM = 0x23b872dd;
    /// @dev ERC-20 `approve(address,uint256)`.
    bytes4 private constant APPROVE = 0x095ea7b3;

    /// @dev `token.transfer(to, amount)`; reverts "transfer failed".
    function safeTransfer(address token, address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(TRANSFER, to, amount), "transfer failed");
    }

    /// @dev `token.transferFrom(from, to, amount)`; reverts "transferFrom failed".
    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(TRANSFER_FROM, from, to, amount), "transferFrom failed");
    }

    /// @dev `token.approve(spender, amount)`; reverts "approve failed".
    function safeApprove(address token, address spender, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(APPROVE, spender, amount), "approve failed");
    }

    /// @dev Sends `amount` MON to `to` with all remaining gas; reverts "send failed". The recipient can
    ///      run code, so callers send last and hold a reentrancy lock.
    function sendValue(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    /// @dev Calls `token`; succeeds only if it has code, did not revert, and returned nothing or `true`.
    function _call(address token, bytes memory data, string memory err) private {
        require(token.code.length != 0, err);
        (bool ok, bytes memory ret) = token.call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), err);
    }
}
