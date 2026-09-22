// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 for tests.
contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    uint256 public feeBps; // optional fee-on-transfer, to test rejection
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        uint256 fee = amount * feeBps / 10_000;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
    }
}

/// @notice Minimal position NFT, standing in for Uniswap's NonfungiblePositionManager.
contract MockPositionManager {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    uint256 public nextId = 1;

    function mint(address to) external returns (uint256 id) {
        id = nextId++;
        ownerOf[id] = to;
    }

    function approve(address to, uint256 id) external {
        require(ownerOf[id] == msg.sender, "not owner");
        getApproved[id] = to;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "wrong from");
        require(msg.sender == from || getApproved[id] == msg.sender, "not approved");
        ownerOf[id] = to;
        getApproved[id] = address(0);
    }
}

/// @notice Adapter that "seeds" by keeping a configurable share of what it is given and refunding the rest.
contract MockAdapter {
    MockPositionManager public immutable npm;
    uint256 public useBps = 10_000; // share of tokens and MON the "pool" takes
    bool public shouldRevert;
    uint256 public lastPrice;
    bool public lastRelaxed;
    uint256 public tokensHeld;
    uint256 public monHeld;

    constructor(MockPositionManager npm_) {
        npm = npm_;
    }

    function setUseBps(uint256 bps) external {
        useBps = bps;
    }

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function seed(address token, uint256 tokenAmount, uint256 price, uint24, bool relaxed, address recipient)
        external
        payable
        returns (address, uint256 nftId)
    {
        require(!shouldRevert, "pool price deviates");
        lastPrice = price;
        lastRelaxed = relaxed;
        uint256 tokUse = tokenAmount * useBps / 10_000;
        uint256 monUse = msg.value * useBps / 10_000;
        MockToken(token).transferFrom(msg.sender, address(this), tokUse);
        tokensHeld += tokUse;
        monHeld += monUse;
        if (msg.value > monUse) {
            (bool ok,) = msg.sender.call{value: msg.value - monUse}("");
            require(ok, "refund failed");
        }
        nftId = npm.mint(recipient);
        return (address(npm), nftId);
    }
}

/// @notice Locker that takes the NFT the way GoPlus does (pull via transferFrom) and records the terms.
contract MockLocker {
    struct Lock {
        address nftManager;
        uint256 nftId;
        address owner;
        address collector;
        uint256 endTime;
        string feeName;
    }

    Lock[] public locks;

    function lock(address nftManager_, uint256 nftId_, address owner_, address collector_, uint256 endTime_, string memory feeName_)
        external
        payable
        returns (uint256 lockId)
    {
        MockPositionManager(nftManager_).transferFrom(msg.sender, address(this), nftId_);
        locks.push(Lock(nftManager_, nftId_, owner_, collector_, endTime_, feeName_));
        return locks.length - 1;
    }

    function lockCount() external view returns (uint256) {
        return locks.length;
    }
}
