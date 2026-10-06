**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [incorrect-exp](#incorrect-exp) (1 results) (High)
 - [reentrancy-balance](#reentrancy-balance) (5 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (10 results) (Medium)
 - [incorrect-equality](#incorrect-equality) (5 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (4 results) (Medium)
 - [unused-return](#unused-return) (4 results) (Medium)
 - [calls-loop](#calls-loop) (8 results) (Low)
 - [reentrancy-benign](#reentrancy-benign) (2 results) (Low)
 - [timestamp](#timestamp) (23 results) (Low)
 - [assembly](#assembly) (1 results) (Informational)
## incorrect-exp
Impact: High
Confidence: Medium
 - [ ] ID-0
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) has bitwise-xor operator ^ instead of the exponentiation operator **: 
	 - [inv = (3 * d) ^ 2](./src/adapters/UniV3PriceMath.sol#L45)

./src/adapters/UniV3PriceMath.sol#L18-L54


## reentrancy-balance
Impact: High
Confidence: Medium
 - [ ] ID-1
Reentrancy in [AuctionEngine.openRound(AuctionEngine.OpenParams)](./src/AuctionEngine.sol#L166-L198):
	External call allowing reentrancy:
	- [p.token.safeTransferFrom(msg.sender,address(this),need)](./src/AuctionEngine.sol#L195)
	Balance read before the call:
	- [before = IERC20Minimal(p.token).balanceOf(address(this))](./src/AuctionEngine.sol#L194)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(IERC20Minimal(p.token).balanceOf(address(this)) - before == need,fee-on-transfer token)](./src/AuctionEngine.sol#L196)
		- stale variable `before`

./src/AuctionEngine.sol#L166-L198


 - [ ] ID-2
Reentrancy in [AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388):
	External call allowing reentrancy:
	- [token.safeApprove(s.adapter,0)](./src/AuctionEngine.sol#L371)
	Balance read before the call:
	- [tokBefore = IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L367)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(tokUsed <= tok && monUsed <= mon,adapter overspent)](./src/AuctionEngine.sol#L374)
		- stale variable `tokUsed`

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-3
Reentrancy in [AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388):
	External call allowing reentrancy:
	- [(npm,nftId) = IDexAdapter(s.adapter).seed{value: mon}(token,tok,price,s.fee,address(this))](./src/AuctionEngine.sol#L370)
	Balance read before the call:
	- [tokBefore = IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L367)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(tokUsed <= tok && monUsed <= mon,adapter overspent)](./src/AuctionEngine.sol#L374)
		- stale variable `tokUsed`

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-4
Reentrancy in [UniswapV3Adapter.seed(address,uint256,uint256,uint24,address)](./src/adapters/UniswapV3Adapter.sol#L134-L175):
	External call allowing reentrancy:
	- [token.safeTransferFrom(msg.sender,address(this),tokenAmount)](./src/adapters/UniswapV3Adapter.sol#L151)
	Balance read before the call:
	- [tokenBase = IERC20Balance(token).balanceOf(address(this))](./src/adapters/UniswapV3Adapter.sol#L149)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(IERC20Balance(token).balanceOf(address(this)) - tokenBase == tokenAmount,fee-on-transfer token)](./src/adapters/UniswapV3Adapter.sol#L152)
		- stale variable `tokenBase`

./src/adapters/UniswapV3Adapter.sol#L134-L175


 - [ ] ID-5
Reentrancy in [AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388):
	External call allowing reentrancy:
	- [token.safeApprove(s.adapter,tok)](./src/AuctionEngine.sol#L369)
	Balance read before the call:
	- [tokBefore = IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L367)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(tokUsed <= tok && monUsed <= mon,adapter overspent)](./src/AuctionEngine.sol#L374)
		- stale variable `tokUsed`

./src/AuctionEngine.sol#L362-L388


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-6
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L40)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L50)

./src/adapters/UniV3PriceMath.sol#L18-L54


 - [ ] ID-7
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) performs a multiplication on the result of a division:
	- [prod0 = prod0 / twos](./src/adapters/UniV3PriceMath.sol#L41)
	- [result = prod0 * inv](./src/adapters/UniV3PriceMath.sol#L52)

./src/adapters/UniV3PriceMath.sol#L18-L54


 - [ ] ID-8
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L40)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L51)

./src/adapters/UniV3PriceMath.sol#L18-L54


 - [ ] ID-9
[UniswapV3Adapter._mintFullRange(address,address,uint24,int24,uint256,uint256,address)](./src/adapters/UniswapV3Adapter.sol#L210-L242) performs a multiplication on the result of a division:
	- [tickUpper = (MAX_TICK / spacing) * spacing](./src/adapters/UniswapV3Adapter.sol#L219)

./src/adapters/UniswapV3Adapter.sol#L210-L242


 - [ ] ID-10
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L40)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L46)

./src/adapters/UniV3PriceMath.sol#L18-L54


 - [ ] ID-11
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L40)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L49)

./src/adapters/UniV3PriceMath.sol#L18-L54


 - [ ] ID-12
[AuctionEngine._lpTargets(uint256,AuctionEngine.Round,UniformClearing.Book)](./src/AuctionEngine.sol#L324-L333) performs a multiplication on the result of a division:
	- [lpMon = (soldLB * b.clearingPrice / PRICE_SCALE) * r.lpShareBps / BPS](./src/AuctionEngine.sol#L332)

./src/AuctionEngine.sol#L324-L333


 - [ ] ID-13
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L40)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L48)

./src/adapters/UniV3PriceMath.sol#L18-L54


 - [ ] ID-14
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L40)
	- [inv = (3 * d) ^ 2](./src/adapters/UniV3PriceMath.sol#L45)

./src/adapters/UniV3PriceMath.sol#L18-L54


 - [ ] ID-15
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L40)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L47)

./src/adapters/UniV3PriceMath.sol#L18-L54


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-16
[ExitAuction._exit(uint256,address)](./src/exit/ExitAuction.sol#L219-L247) uses a dangerous strict equality:
	- [require(bool,string)(got == assets,redeem mismatch)](./src/exit/ExitAuction.sol#L242)

./src/exit/ExitAuction.sol#L219-L247


 - [ ] ID-17
[UniformClearing.findHint(uint256,uint256)](./src/UniformClearing.sol#L162-L170) uses a dangerous strict equality:
	- [hint == NONE || hint <= price](./src/UniformClearing.sol#L164)

./src/UniformClearing.sol#L162-L170


 - [ ] ID-18
[UniswapV3Adapter.seed(address,uint256,uint256,uint24,address)](./src/adapters/UniswapV3Adapter.sol#L134-L175) uses a dangerous strict equality:
	- [require(bool,string)(IERC20Balance(token).balanceOf(address(this)) - tokenBase == tokenAmount,fee-on-transfer token)](./src/adapters/UniswapV3Adapter.sol#L152)

./src/adapters/UniswapV3Adapter.sol#L134-L175


 - [ ] ID-19
[AuctionEngine.openRound(AuctionEngine.OpenParams)](./src/AuctionEngine.sol#L166-L198) uses a dangerous strict equality:
	- [require(bool,string)(IERC20Minimal(p.token).balanceOf(address(this)) - before == need,fee-on-transfer token)](./src/AuctionEngine.sol#L196)

./src/AuctionEngine.sol#L166-L198


 - [ ] ID-20
[ExitAuction._exit(uint256,address)](./src/exit/ExitAuction.sol#L219-L247) uses a dangerous strict equality:
	- [r.exitsClaimed == ledgers[roundId].reveals](./src/exit/ExitAuction.sol#L237)

./src/exit/ExitAuction.sol#L219-L247


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-21
[UniswapV3Adapter._preparePool(address,address,uint24,uint160).current](./src/adapters/UniswapV3Adapter.sol#L183) is a local variable never initialized

./src/adapters/UniswapV3Adapter.sol#L183


 - [ ] ID-22
[AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256).tokensUsed](./src/AuctionEngine.sol#L341) is a local variable never initialized

./src/AuctionEngine.sol#L341


 - [ ] ID-23
[AuctionEngine._validate(AuctionEngine.OpenParams).sum](./src/AuctionEngine.sol#L217) is a local variable never initialized

./src/AuctionEngine.sol#L217


 - [ ] ID-24
[AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256).monUsed](./src/AuctionEngine.sol#L342) is a local variable never initialized

./src/AuctionEngine.sol#L342


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-25
[UniswapV3Adapter._preparePool(address,address,uint24,uint160)](./src/adapters/UniswapV3Adapter.sol#L178-L208) ignores return value by [(moved,None,None,None,None,None,None) = IUniswapV3PoolLike(pool).slot0()](./src/adapters/UniswapV3Adapter.sol#L201)

./src/adapters/UniswapV3Adapter.sol#L178-L208


 - [ ] ID-26
[UniswapV3Adapter._preparePool(address,address,uint24,uint160)](./src/adapters/UniswapV3Adapter.sol#L178-L208) ignores return value by [IUniswapV3PoolLike(pool).swap{gas: REPRICE_GAS}(address(this),target < current,1,target,abi.encode(token0,token1,fee))](./src/adapters/UniswapV3Adapter.sol#L197-L204)

./src/adapters/UniswapV3Adapter.sol#L178-L208


 - [ ] ID-27
[UniswapV3Adapter._preparePool(address,address,uint24,uint160)](./src/adapters/UniswapV3Adapter.sol#L178-L208) ignores return value by [(current,None,None,None,None,None,None) = IUniswapV3PoolLike(pool).slot0()](./src/adapters/UniswapV3Adapter.sol#L184)

./src/adapters/UniswapV3Adapter.sol#L178-L208


 - [ ] ID-28
[UniswapV3Adapter._mintFullRange(address,address,uint24,int24,uint256,uint256,address)](./src/adapters/UniswapV3Adapter.sol#L210-L242) ignores return value by [(nftId,None,None,None) = positionManager.mint(INonfungiblePositionManagerLike.MintParams({token0:token0,token1:token1,fee:fee,tickLower:- tickUpper,tickUpper:tickUpper,amount0Desired:amount0,amount1Desired:amount1,amount0Min:0,amount1Min:0,recipient:recipient,deadline:block.timestamp}))](./src/adapters/UniswapV3Adapter.sol#L225-L239)

./src/adapters/UniswapV3Adapter.sol#L210-L242


## calls-loop
Impact: Low
Confidence: Medium
 - [ ] ID-29
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388) has external calls inside a loop: [require(bool,string)(IERC721Minimal(npm).ownerOf(nftId) == address(this),position not received)](./src/AuctionEngine.sol#L375)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-30
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388) has external calls inside a loop: [lockId = locker.lock(npm,nftId,r.creator,r.creator,block.timestamp + r.lockDuration,r.lockFeeTier)](./src/AuctionEngine.sol#L379-L386)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-31
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388) has external calls inside a loop: [IERC721Minimal(npm).approve(address(locker),nftId)](./src/AuctionEngine.sol#L378)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-32
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388) has external calls inside a loop: [(npm,nftId) = IDexAdapter(s.adapter).seed{value: mon}(token,tok,price,s.fee,address(this))](./src/AuctionEngine.sol#L370)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-33
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388) has external calls inside a loop: [tokBefore = IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L367)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-34
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388) has external calls inside a loop: [lockId = locker.lock(npm,nftId,address(this),r.creator,permanentLockEnd,r.lockFeeTier)](./src/AuctionEngine.sol#L379-L386)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-35
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L362-L388) has external calls inside a loop: [tokUsed = tokBefore - IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L372)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L362-L388


 - [ ] ID-36
[AuctionEngine._validate(AuctionEngine.OpenParams)](./src/AuctionEngine.sol#L200-L238) has external calls inside a loop: [require(bool,string)(IDexAdapter(p.dexSplits[i].adapter).supportsFee(p.dexSplits[i].fee),fee tier not supported)](./src/AuctionEngine.sol#L220)
	Calls stack containing the loop:
		AuctionEngine.openRound(AuctionEngine.OpenParams)

./src/AuctionEngine.sol#L200-L238


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-37
Reentrancy in [UniswapV3Adapter._preparePool(address,address,uint24,uint160)](./src/adapters/UniswapV3Adapter.sol#L178-L208):
	External calls:
	- [IUniswapV3PoolLike(pool).swap{gas: REPRICE_GAS}(address(this),target < current,1,target,abi.encode(token0,token1,fee))](./src/adapters/UniswapV3Adapter.sol#L197-L204)
	State variables written after the call(s):
	- [_repricingPool = address(0)](./src/adapters/UniswapV3Adapter.sol#L205)

./src/adapters/UniswapV3Adapter.sol#L178-L208


 - [ ] ID-38
Reentrancy in [UniswapV3Adapter.seed(address,uint256,uint256,uint24,address)](./src/adapters/UniswapV3Adapter.sol#L134-L175):
	External calls:
	- [token.safeTransferFrom(msg.sender,address(this),tokenAmount)](./src/adapters/UniswapV3Adapter.sol#L151)
	- [IWMON(wmon).deposit{value: msg.value}()](./src/adapters/UniswapV3Adapter.sol#L153)
	- [pool = _preparePool(token0,token1,fee,target)](./src/adapters/UniswapV3Adapter.sol#L156)
		- [positionManager.createAndInitializePoolIfNecessary(token0,token1,fee,target)](./src/adapters/UniswapV3Adapter.sol#L187)
		- [IUniswapV3PoolLike(pool).swap{gas: REPRICE_GAS}(address(this),target < current,1,target,abi.encode(token0,token1,fee))](./src/adapters/UniswapV3Adapter.sol#L197-L204)
	External calls sending eth:
	- [IWMON(wmon).deposit{value: msg.value}()](./src/adapters/UniswapV3Adapter.sol#L153)
	State variables written after the call(s):
	- [pool = _preparePool(token0,token1,fee,target)](./src/adapters/UniswapV3Adapter.sol#L156)
		- [_repricingPool = pool](./src/adapters/UniswapV3Adapter.sol#L196)
		- [_repricingPool = address(0)](./src/adapters/UniswapV3Adapter.sol#L205)

./src/adapters/UniswapV3Adapter.sol#L134-L175


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-39
[ExitAuction.settle(uint256,uint256)](./src/exit/ExitAuction.sol#L175-L190) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.commitEnd != 0,unknown round)](./src/exit/ExitAuction.sol#L177)
	- [require(bool,string)(block.timestamp >= r.revealEnd,reveal window open)](./src/exit/ExitAuction.sol#L178)

./src/exit/ExitAuction.sol#L175-L190


 - [ ] ID-40
[ExitAuction._sealTerms(uint256)](./src/exit/ExitAuction.sol#L150-L159) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.commitEnd != 0,unknown round)](./src/exit/ExitAuction.sol#L157)

./src/exit/ExitAuction.sol#L150-L159


 - [ ] ID-41
[AuctionEngine.constructor(address,address[],uint256,uint256)](./src/AuctionEngine.sol#L151-L162) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(permanentLockEnd_ > block.timestamp,lock end in past)](./src/AuctionEngine.sol#L153)

./src/AuctionEngine.sol#L151-L162


 - [ ] ID-42
[SealingLayer.commit(uint256,bytes32,bytes32[],bytes)](./src/SealingLayer.sol#L28-L47) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(block.timestamp < commitEnd,commit window closed)](./src/SealingLayer.sol#L34)

./src/SealingLayer.sol#L28-L47


 - [ ] ID-43
[SealingLayer._reveal(uint256,uint96,uint96,bytes32,uint256)](./src/SealingLayer.sol#L61-L71) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(block.timestamp >= commitEnd && block.timestamp < revealEnd,reveal window closed)](./src/SealingLayer.sol#L63)

./src/SealingLayer.sol#L61-L71


 - [ ] ID-44
[AuctionEngine._onReveal(uint256,address,uint96,uint96,uint256)](./src/AuctionEngine.sol#L253-L263) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(price % r.tickSize == 0 && price >= r.reservePrice,price off grid or below reserve)](./src/AuctionEngine.sol#L255)
	- [require(bool,string)(_mulDivUp(price,amount,PRICE_SCALE) < r.depositAmount,bid exceeds deposit)](./src/AuctionEngine.sol#L257)
	- [require(bool,string)(_mulDivUp(r.reservePrice,amount,PRICE_SCALE) >= r.minBidSize,below minimum bid)](./src/AuctionEngine.sol#L260)

./src/AuctionEngine.sol#L253-L263


 - [ ] ID-45
[AuctionEngine.abandonLP(uint256)](./src/AuctionEngine.sol#L300-L316) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(! r.lpDone,LP already done)](./src/AuctionEngine.sol#L304)
	- [require(bool,string)(block.timestamp >= uint256(r.settledAt) + lpGracePeriod,grace period not over)](./src/AuctionEngine.sol#L305)

./src/AuctionEngine.sol#L300-L316


 - [ ] ID-46
[AuctionEngine.sweepDust(uint256)](./src/AuctionEngine.sol#L499-L507) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.lpDone && ! r.dustSwept,not sweepable)](./src/AuctionEngine.sol#L502)

./src/AuctionEngine.sol#L499-L507


 - [ ] ID-47
[AuctionEngine._deliver(uint256,address)](./src/AuctionEngine.sol#L451-L468) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.claimsOpen,claims not open)](./src/AuctionEngine.sol#L453)

./src/AuctionEngine.sol#L451-L468


 - [ ] ID-48
[AuctionEngine._sealTerms(uint256)](./src/AuctionEngine.sol#L242-L251) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.creator != address(0),unknown round)](./src/AuctionEngine.sol#L249)

./src/AuctionEngine.sol#L242-L251


 - [ ] ID-49
[ExitAuction._exit(uint256,address)](./src/exit/ExitAuction.sol#L219-L247) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.allocatedTotal <= sold,over-allocated)](./src/exit/ExitAuction.sol#L229)
	- [require(bool,string)(r.allocatedTotal + r.returnedTotal <= r.escrowed,share accounting)](./src/exit/ExitAuction.sol#L230)
	- [r.exitsClaimed == ledgers[roundId].reveals](./src/exit/ExitAuction.sol#L237)
	- [alloc != 0](./src/exit/ExitAuction.sol#L240)
	- [require(bool,string)(got == assets,redeem mismatch)](./src/exit/ExitAuction.sol#L242)
	- [payout != 0](./src/exit/ExitAuction.sol#L243)
	- [donation != 0](./src/exit/ExitAuction.sol#L244)
	- [back != 0](./src/exit/ExitAuction.sol#L246)

./src/exit/ExitAuction.sol#L219-L247


 - [ ] ID-50
[ExitAuction._refund(uint256,address)](./src/exit/ExitAuction.sol#L249-L255) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(_books[roundId].settled,not settled)](./src/exit/ExitAuction.sol#L250)

./src/exit/ExitAuction.sol#L249-L255


 - [ ] ID-51
[ExitAuction.reservedShares()](./src/exit/ExitAuction.sol#L275-L279) uses timestamp for comparisons
	Dangerous comparisons:
	- [id != 0 && ! _books[id].settled](./src/exit/ExitAuction.sol#L278)

./src/exit/ExitAuction.sol#L275-L279


 - [ ] ID-52
[AuctionEngine._tokensOut(AuctionEngine.Round,uint256)](./src/AuctionEngine.sol#L559-L562) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.tokensOut <= uint256(r.sellAmount) + r.tokenReserve,token accounting)](./src/AuctionEngine.sol#L561)

./src/AuctionEngine.sol#L559-L562


 - [ ] ID-53
[AuctionEngine.settle(uint256,uint256)](./src/AuctionEngine.sol#L268-L278) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.creator != address(0),unknown round)](./src/AuctionEngine.sol#L270)
	- [require(bool,string)(block.timestamp >= r.revealEnd,reveal window open)](./src/AuctionEngine.sol#L271)

./src/AuctionEngine.sol#L268-L278


 - [ ] ID-54
[ExitAuction.openExitRound()](./src/exit/ExitAuction.sol#L123-L145) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(_books[prev].settled,previous round not settled)](./src/exit/ExitAuction.sol#L126)
	- [require(bool,string)(block.number >= uint256(_rounds[prev].settledBlock) + roundGapBlocks,too soon)](./src/exit/ExitAuction.sol#L127)
	- [capacity > maxExitSharesPerRound](./src/exit/ExitAuction.sol#L133)
	- [require(bool,string)(capacity != 0,no exit capacity)](./src/exit/ExitAuction.sol#L134)
	- [idle > owed](./src/exit/ExitAuction.sol#L131)

./src/exit/ExitAuction.sol#L123-L145


 - [ ] ID-55
[ExitAuction._quote(uint256,address)](./src/exit/ExitAuction.sol#L294-L309) uses timestamp for comparisons
	Dangerous comparisons:
	- [assets < atSettle](./src/exit/ExitAuction.sol#L306)

./src/exit/ExitAuction.sol#L294-L309


 - [ ] ID-56
[AuctionEngine.seedLP(uint256)](./src/AuctionEngine.sol#L283-L295) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(! r.lpDone,LP already done)](./src/AuctionEngine.sol#L287)

./src/AuctionEngine.sol#L283-L295


 - [ ] ID-57
[AuctionEngine._vestedAmount(AuctionEngine.Round,uint256)](./src/AuctionEngine.sol#L550-L557) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp <= start](./src/AuctionEngine.sol#L553)
	- [elapsed >= r.vestDuration](./src/AuctionEngine.sol#L555)

./src/AuctionEngine.sol#L550-L557


 - [ ] ID-58
[AuctionEngine.claimVested(uint256)](./src/AuctionEngine.sol#L471-L482) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(v.total != 0,no vesting)](./src/AuctionEngine.sol#L474)
	- [require(bool,string)(amount != 0,nothing vested)](./src/AuctionEngine.sol#L477)

./src/AuctionEngine.sol#L471-L482


 - [ ] ID-59
[AuctionEngine.withdrawProceeds(uint256)](./src/AuctionEngine.sol#L486-L496) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(msg.sender == r.creator,not creator)](./src/AuctionEngine.sol#L488)
	- [require(bool,string)(r.lpDone,LP not done)](./src/AuctionEngine.sol#L489)

./src/AuctionEngine.sol#L486-L496


 - [ ] ID-60
[AuctionEngine._validate(AuctionEngine.OpenParams)](./src/AuctionEngine.sol#L200-L238) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(p.commitEnd > block.timestamp && p.revealEnd > p.commitEnd,bad windows)](./src/AuctionEngine.sol#L211)

./src/AuctionEngine.sol#L200-L238


 - [ ] ID-61
[DepositLedger.burnUnrevealed(uint256)](./src/DepositLedger.sol#L45-L56) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(block.timestamp >= _revealEndOf(roundId),reveal window open)](./src/DepositLedger.sol#L46)

./src/DepositLedger.sol#L45-L56


## assembly
Impact: Informational
Confidence: High
 - [ ] ID-62
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L18-L54) uses assembly
	- [INLINE ASM](./src/adapters/UniV3PriceMath.sol#L22-L26)
	- [INLINE ASM](./src/adapters/UniV3PriceMath.sol#L33-L37)
	- [INLINE ASM](./src/adapters/UniV3PriceMath.sol#L39-L43)

./src/adapters/UniV3PriceMath.sol#L18-L54


