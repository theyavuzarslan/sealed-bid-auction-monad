// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

/// @notice Native-value deposit accounting shared by the sealing layer.
abstract contract DepositLedger {
    struct Deposit {
        uint256 locked;
        uint256 appliedToFill;
        uint256 refunded;
        uint256 slashed;
    }

    mapping(uint256 => mapping(address => Deposit)) public deposits;
    address payable public immutable slashDestination;
    address payable public immutable fillDestination;
    bool private entered;

    event Slashed(uint256 indexed roundId, address indexed bidder, uint256 amount);

    constructor(address payable slashDestination_, address payable fillDestination_) {
        require(slashDestination_ != address(0) && fillDestination_ != address(0), "zero destination");
        require(slashDestination_ != address(this) && fillDestination_ != address(this), "self destination");
        slashDestination = slashDestination_;
        // TODO: not specified: which clearing core / LP seeder receives fill proceeds?
        fillDestination = fillDestination_;
    }

    modifier nonReentrant() {
        require(!entered, "reentrancy");
        entered = true;
        _;
        entered = false;
    }

    function _lockDeposit(uint256 roundId, address bidder, uint256 amount) internal {
        require(amount != 0 && deposits[roundId][bidder].locked == 0, "invalid deposit");
        deposits[roundId][bidder].locked = amount;
    }

    function slashUnrevealed(uint256 roundId, address[] calldata bidders) external nonReentrant {
        for (uint256 i; i < bidders.length; ++i) {
            address bidder = bidders[i];
            require(_canSlash(roundId, bidder), "not slashable");
            Deposit storage deposit = deposits[roundId][bidder];
            _requireUnsettled(deposit);
            deposit.slashed = deposit.locked;
            _assertSettled(deposit);
            emit Slashed(roundId, bidder, deposit.slashed);
            _send(slashDestination, deposit.slashed);
        }
    }

    /// @dev Call only after authenticated clearing-core settlement; never accept a bidder-supplied fill.
    function _releaseDeposit(uint256 roundId, address bidder, uint256 appliedToFill) internal nonReentrant {
        require(_canRelease(roundId, bidder), "not settled and revealed");
        Deposit storage deposit = deposits[roundId][bidder];
        _requireUnsettled(deposit);
        require(appliedToFill <= deposit.locked, "fill exceeds deposit");
        deposit.appliedToFill = appliedToFill;
        deposit.refunded = deposit.locked - appliedToFill;
        _assertSettled(deposit);
        _send(fillDestination, appliedToFill);
        _send(payable(bidder), deposit.refunded);
    }

    function _requireUnsettled(Deposit storage deposit) private view {
        require(deposit.locked != 0, "no deposit");
        require(deposit.appliedToFill == 0 && deposit.refunded == 0 && deposit.slashed == 0, "already settled");
    }

    function _assertSettled(Deposit storage deposit) private view {
        assert(deposit.locked == deposit.appliedToFill + deposit.refunded + deposit.slashed);
    }

    function _send(address payable recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = recipient.call{value: amount}("");
        require(success, "transfer failed");
    }

    // TODO: not specified: clearing-core settlement authentication / integration interface.
    function _canRelease(uint256 roundId, address bidder) internal view virtual returns (bool);
    function _canSlash(uint256 roundId, address bidder) internal view virtual returns (bool);
}
