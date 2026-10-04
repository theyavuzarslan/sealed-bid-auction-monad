// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-20 and native transfers that tolerate tokens returning no value, and reject
///         calls to addresses with no code (a silent "success" from a non-contract).
library SafeTransferLib {
    function safeTransfer(address token, address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount), "transfer failed");
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0x23b872dd, from, to, amount), "transferFrom failed");
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0x095ea7b3, spender, amount), "approve failed");
    }

    function sendValue(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    function _call(address token, bytes memory data, string memory err) private {
        require(token.code.length != 0, err);
        (bool ok, bytes memory ret) = token.call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), err);
    }
}
