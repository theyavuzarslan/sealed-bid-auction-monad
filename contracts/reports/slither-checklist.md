'forge clean' running (wd: contracts)
'forge config --json' running
'forge build --build-info --deny never --skip ./test/** ./script/** --force' running (wd: contracts)
**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [incorrect-exp](#incorrect-exp) (1 results) (High)
 - [reentrancy-balance](#reentrancy-balance) (5 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (10 results) (Medium)
 - [incorrect-equality](#incorrect-equality) (4 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (4 results) (Medium)
 - [unused-return](#unused-return) (4 results) (Medium)
 - [calls-loop](#calls-loop) (8 results) (Low)
 - [reentrancy-benign](#reentrancy-benign) (2 results) (Low)
 - [timestamp](#timestamp) (23 results) (Low)
 - [assembly](#assembly) (2 results) (Informational)
## incorrect-exp
Impact: High
Confidence: Medium
 - [ ] ID-0
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) has bitwise-xor operator ^ instead of the exponentiation operator **: 
	 - [inv = (3 * d) ^ 2](./src/adapters/UniV3PriceMath.sol#L50)

./src/adapters/UniV3PriceMath.sol#L21-L59


## reentrancy-balance
Impact: High
Confidence: Medium
 - [ ] ID-1
Reentrancy in [AuctionEngine.openRound(AuctionEngine.OpenParams)](./src/AuctionEngine.sol#L211-L246):
	External call allowing reentrancy:
	- [p.token.safeTransferFrom(msg.sender,address(this),need)](./src/AuctionEngine.sol#L243)
	Balance read before the call:
	- [before = IERC20Minimal(p.token).balanceOf(address(this))](./src/AuctionEngine.sol#L242)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(IERC20Minimal(p.token).balanceOf(address(this)) - before == need,fee-on-transfer token)](./src/AuctionEngine.sol#L244)
		- stale variable `before`

./src/AuctionEngine.sol#L211-L246


 - [ ] ID-2
Reentrancy in [AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456):
	External call allowing reentrancy:
	- [token.safeApprove(s.adapter,tok)](./src/AuctionEngine.sol#L437)
	Balance read before the call:
	- [tokBefore = IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L435)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(tokUsed <= tok && monUsed <= mon,adapter overspent)](./src/AuctionEngine.sol#L442)
		- stale variable `tokUsed`

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-3
Reentrancy in [AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456):
	External call allowing reentrancy:
	- [token.safeApprove(s.adapter,0)](./src/AuctionEngine.sol#L439)
	Balance read before the call:
	- [tokBefore = IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L435)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(tokUsed <= tok && monUsed <= mon,adapter overspent)](./src/AuctionEngine.sol#L442)
		- stale variable `tokUsed`

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-4
Reentrancy in [AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456):
	External call allowing reentrancy:
	- [(npm,nftId) = IDexAdapter(s.adapter).seed{value: mon}(token,tok,price,s.fee,address(this))](./src/AuctionEngine.sol#L438)
	Balance read before the call:
	- [tokBefore = IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L435)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(tokUsed <= tok && monUsed <= mon,adapter overspent)](./src/AuctionEngine.sol#L442)
		- stale variable `tokUsed`

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-5
Reentrancy in [UniswapV3Adapter.seed(address,uint256,uint256,uint24,address)](./src/adapters/UniswapV3Adapter.sol#L156-L197):
	External call allowing reentrancy:
	- [token.safeTransferFrom(msg.sender,address(this),tokenAmount)](./src/adapters/UniswapV3Adapter.sol#L173)
	Balance read before the call:
	- [tokenBase = IERC20Minimal(token).balanceOf(address(this))](./src/adapters/UniswapV3Adapter.sol#L171)
	Possible stale balance used after the call in a condition:
	- [require(bool,string)(IERC20Minimal(token).balanceOf(address(this)) - tokenBase == tokenAmount,fee-on-transfer token)](./src/adapters/UniswapV3Adapter.sol#L174)
		- stale variable `tokenBase`

./src/adapters/UniswapV3Adapter.sol#L156-L197


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-6
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L45)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L53)

./src/adapters/UniV3PriceMath.sol#L21-L59


 - [ ] ID-7
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L45)
	- [inv = (3 * d) ^ 2](./src/adapters/UniV3PriceMath.sol#L50)

./src/adapters/UniV3PriceMath.sol#L21-L59


 - [ ] ID-8
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L45)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L56)

./src/adapters/UniV3PriceMath.sol#L21-L59


 - [ ] ID-9
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L45)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L54)

./src/adapters/UniV3PriceMath.sol#L21-L59


 - [ ] ID-10
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L45)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L51)

./src/adapters/UniV3PriceMath.sol#L21-L59


 - [ ] ID-11
[AuctionEngine._lpTargets(uint256,AuctionEngine.Round,UniformClearing.Book)](./src/AuctionEngine.sol#L389-L398) performs a multiplication on the result of a division:
	- [lpMon = (soldLB * b.clearingPrice / PRICE_SCALE) * r.lpShareBps / BPS](./src/AuctionEngine.sol#L397)

./src/AuctionEngine.sol#L389-L398


 - [ ] ID-12
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L45)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L55)

./src/adapters/UniV3PriceMath.sol#L21-L59


 - [ ] ID-13
[UniswapV3Adapter._mintFullRange(address,address,uint24,int24,uint256,uint256,address)](./src/adapters/UniswapV3Adapter.sol#L259-L291) performs a multiplication on the result of a division:
	- [tickUpper = (MAX_TICK / spacing) * spacing](./src/adapters/UniswapV3Adapter.sol#L268)

./src/adapters/UniswapV3Adapter.sol#L259-L291


 - [ ] ID-14
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) performs a multiplication on the result of a division:
	- [d = d / twos](./src/adapters/UniV3PriceMath.sol#L45)
	- [inv *= 2 - d * inv](./src/adapters/UniV3PriceMath.sol#L52)

./src/adapters/UniV3PriceMath.sol#L21-L59


 - [ ] ID-15
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) performs a multiplication on the result of a division:
	- [prod0 = prod0 / twos](./src/adapters/UniV3PriceMath.sol#L46)
	- [result = prod0 * inv](./src/adapters/UniV3PriceMath.sol#L57)

./src/adapters/UniV3PriceMath.sol#L21-L59


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-16
[UniformClearing.findHint(uint256,uint256)](./src/UniformClearing.sol#L60-L68) uses a dangerous strict equality:
	- [hint == NONE || hint <= price](./src/UniformClearing.sol#L62)

./src/UniformClearing.sol#L60-L68


 - [ ] ID-17
[UniswapV3Adapter.seed(address,uint256,uint256,uint24,address)](./src/adapters/UniswapV3Adapter.sol#L156-L197) uses a dangerous strict equality:
	- [require(bool,string)(IERC20Minimal(token).balanceOf(address(this)) - tokenBase == tokenAmount,fee-on-transfer token)](./src/adapters/UniswapV3Adapter.sol#L174)

./src/adapters/UniswapV3Adapter.sol#L156-L197


 - [ ] ID-18
[ExitAuction._exit(uint256,address)](./src/exit/ExitAuction.sol#L266-L297) uses a dangerous strict equality:
	- [r.exitsClaimed == ledgers[roundId].reveals](./src/exit/ExitAuction.sol#L284)

./src/exit/ExitAuction.sol#L266-L297


 - [ ] ID-19
[AuctionEngine.openRound(AuctionEngine.OpenParams)](./src/AuctionEngine.sol#L211-L246) uses a dangerous strict equality:
	- [require(bool,string)(IERC20Minimal(p.token).balanceOf(address(this)) - before == need,fee-on-transfer token)](./src/AuctionEngine.sol#L244)

./src/AuctionEngine.sol#L211-L246


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-20
[UniswapV3Adapter._preparePool(address,address,uint24,uint160).current](./src/adapters/UniswapV3Adapter.sol#L230) is a local variable never initialized

./src/adapters/UniswapV3Adapter.sol#L230


 - [ ] ID-21
[AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256).tokensUsed](./src/AuctionEngine.sol#L406) is a local variable never initialized

./src/AuctionEngine.sol#L406


 - [ ] ID-22
[AuctionEngine._validate(AuctionEngine.OpenParams).sum](./src/AuctionEngine.sol#L267) is a local variable never initialized

./src/AuctionEngine.sol#L267


 - [ ] ID-23
[AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256).monUsed](./src/AuctionEngine.sol#L407) is a local variable never initialized

./src/AuctionEngine.sol#L407


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-24
[UniswapV3Adapter._preparePool(address,address,uint24,uint160)](./src/adapters/UniswapV3Adapter.sol#L228-L255) ignores return value by [IUniswapV3PoolLike(pool).swap{gas: REPRICE_GAS}(address(this),target < current,1,target,abi.encode(token0,token1,fee))](./src/adapters/UniswapV3Adapter.sol#L244-L251)

./src/adapters/UniswapV3Adapter.sol#L228-L255


 - [ ] ID-25
[UniswapV3Adapter._preparePool(address,address,uint24,uint160)](./src/adapters/UniswapV3Adapter.sol#L228-L255) ignores return value by [(current,None,None,None,None,None,None) = IUniswapV3PoolLike(pool).slot0()](./src/adapters/UniswapV3Adapter.sol#L231)

./src/adapters/UniswapV3Adapter.sol#L228-L255


 - [ ] ID-26
[UniswapV3Adapter._preparePool(address,address,uint24,uint160)](./src/adapters/UniswapV3Adapter.sol#L228-L255) ignores return value by [(moved,None,None,None,None,None,None) = IUniswapV3PoolLike(pool).slot0()](./src/adapters/UniswapV3Adapter.sol#L248)

./src/adapters/UniswapV3Adapter.sol#L228-L255


 - [ ] ID-27
[UniswapV3Adapter._mintFullRange(address,address,uint24,int24,uint256,uint256,address)](./src/adapters/UniswapV3Adapter.sol#L259-L291) ignores return value by [(nftId,None,None,None) = positionManager.mint(INonfungiblePositionManagerLike.MintParams({token0:token0,token1:token1,fee:fee,tickLower:- tickUpper,tickUpper:tickUpper,amount0Desired:amount0,amount1Desired:amount1,amount0Min:0,amount1Min:0,recipient:recipient,deadline:block.timestamp}))](./src/adapters/UniswapV3Adapter.sol#L274-L288)

./src/adapters/UniswapV3Adapter.sol#L259-L291


## calls-loop
Impact: Low
Confidence: Medium
 - [ ] ID-28
[AuctionEngine._validate(AuctionEngine.OpenParams)](./src/AuctionEngine.sol#L249-L288) has external calls inside a loop: [require(bool,string)(IDexAdapter(p.dexSplits[i].adapter).supportsFee(p.dexSplits[i].fee),fee tier not supported)](./src/AuctionEngine.sol#L270)
	Calls stack containing the loop:
		AuctionEngine.openRound(AuctionEngine.OpenParams)

./src/AuctionEngine.sol#L249-L288


 - [ ] ID-29
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456) has external calls inside a loop: [require(bool,string)(IERC721Minimal(npm).ownerOf(nftId) == address(this),position not received)](./src/AuctionEngine.sol#L443)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-30
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456) has external calls inside a loop: [lockId = locker.lock(npm,nftId,address(this),r.creator,permanentLockEnd,r.lockFeeTier)](./src/AuctionEngine.sol#L447-L454)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-31
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456) has external calls inside a loop: [tokUsed = tokBefore - IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L440)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-32
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456) has external calls inside a loop: [IERC721Minimal(npm).approve(address(locker),nftId)](./src/AuctionEngine.sol#L446)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-33
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456) has external calls inside a loop: [(npm,nftId) = IDexAdapter(s.adapter).seed{value: mon}(token,tok,price,s.fee,address(this))](./src/AuctionEngine.sol#L438)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-34
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456) has external calls inside a loop: [tokBefore = IERC20Minimal(token).balanceOf(address(this))](./src/AuctionEngine.sol#L435)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L430-L456


 - [ ] ID-35
[AuctionEngine._seedOne(uint256,AuctionEngine.Round,AuctionEngine.DexSplit,uint256,uint256,uint256)](./src/AuctionEngine.sol#L430-L456) has external calls inside a loop: [lockId = locker.lock(npm,nftId,r.creator,r.creator,block.timestamp + r.lockDuration,r.lockFeeTier)](./src/AuctionEngine.sol#L447-L454)
	Calls stack containing the loop:
		AuctionEngine.seedLP(uint256)
		AuctionEngine._seed(uint256,AuctionEngine.Round,uint256,uint256,uint256)

./src/AuctionEngine.sol#L430-L456


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-36
Reentrancy in [UniswapV3Adapter._preparePool(address,address,uint24,uint160)](./src/adapters/UniswapV3Adapter.sol#L228-L255):
	External calls:
	- [IUniswapV3PoolLike(pool).swap{gas: REPRICE_GAS}(address(this),target < current,1,target,abi.encode(token0,token1,fee))](./src/adapters/UniswapV3Adapter.sol#L244-L251)
	State variables written after the call(s):
	- [_repricingPool = address(0)](./src/adapters/UniswapV3Adapter.sol#L252)

./src/adapters/UniswapV3Adapter.sol#L228-L255


 - [ ] ID-37
Reentrancy in [UniswapV3Adapter.seed(address,uint256,uint256,uint24,address)](./src/adapters/UniswapV3Adapter.sol#L156-L197):
	External calls:
	- [token.safeTransferFrom(msg.sender,address(this),tokenAmount)](./src/adapters/UniswapV3Adapter.sol#L173)
	- [IWMON(wmon).deposit{value: msg.value}()](./src/adapters/UniswapV3Adapter.sol#L175)
	- [pool = _preparePool(token0,token1,fee,target)](./src/adapters/UniswapV3Adapter.sol#L178)
		- [positionManager.createAndInitializePoolIfNecessary(token0,token1,fee,target)](./src/adapters/UniswapV3Adapter.sol#L234)
		- [IUniswapV3PoolLike(pool).swap{gas: REPRICE_GAS}(address(this),target < current,1,target,abi.encode(token0,token1,fee))](./src/adapters/UniswapV3Adapter.sol#L244-L251)
	External calls sending eth:
	- [IWMON(wmon).deposit{value: msg.value}()](./src/adapters/UniswapV3Adapter.sol#L175)
	State variables written after the call(s):
	- [pool = _preparePool(token0,token1,fee,target)](./src/adapters/UniswapV3Adapter.sol#L178)
		- [_repricingPool = pool](./src/adapters/UniswapV3Adapter.sol#L243)
		- [_repricingPool = address(0)](./src/adapters/UniswapV3Adapter.sol#L252)

./src/adapters/UniswapV3Adapter.sol#L156-L197


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-38
[AuctionEngine._sealTerms(uint256)](./src/AuctionEngine.sol#L293-L302) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.creator != address(0),unknown round)](./src/AuctionEngine.sol#L300)

./src/AuctionEngine.sol#L293-L302


 - [ ] ID-39
[AuctionEngine.settle(uint256,uint256)](./src/AuctionEngine.sol#L325-L337) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.creator != address(0),unknown round)](./src/AuctionEngine.sol#L327)
	- [require(bool,string)(block.timestamp >= r.revealEnd,reveal window open)](./src/AuctionEngine.sol#L328)

./src/AuctionEngine.sol#L325-L337


 - [ ] ID-40
[AuctionEngine.claimVested(uint256)](./src/AuctionEngine.sol#L554-L567) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(v.total != 0,no vesting)](./src/AuctionEngine.sol#L557)
	- [require(bool,string)(amount != 0,nothing vested)](./src/AuctionEngine.sol#L560)

./src/AuctionEngine.sol#L554-L567


 - [ ] ID-41
[AuctionEngine.sweepDust(uint256)](./src/AuctionEngine.sol#L588-L596) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.lpDone && ! r.dustSwept,not sweepable)](./src/AuctionEngine.sol#L591)

./src/AuctionEngine.sol#L588-L596


 - [ ] ID-42
[AuctionEngine._deliver(uint256,address)](./src/AuctionEngine.sol#L531-L550) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.claimsOpen,claims not open)](./src/AuctionEngine.sol#L533)

./src/AuctionEngine.sol#L531-L550


 - [ ] ID-43
[ExitAuction.settle(uint256,uint256)](./src/exit/ExitAuction.sol#L213-L230) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.commitEnd != 0,unknown round)](./src/exit/ExitAuction.sol#L215)
	- [require(bool,string)(block.timestamp >= r.revealEnd,reveal window open)](./src/exit/ExitAuction.sol#L216)

./src/exit/ExitAuction.sol#L213-L230


 - [ ] ID-44
[AuctionEngine._tokensOut(AuctionEngine.Round,uint256)](./src/AuctionEngine.sol#L668-L671) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.tokensOut <= uint256(r.sellAmount) + r.tokenReserve,token accounting)](./src/AuctionEngine.sol#L670)

./src/AuctionEngine.sol#L668-L671


 - [ ] ID-45
[SealingLayer._reveal(uint256,uint96,uint96,bytes32,uint256)](./src/SealingLayer.sol#L108-L118) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(block.timestamp >= commitEnd && block.timestamp < revealEnd,reveal window closed)](./src/SealingLayer.sol#L110)

./src/SealingLayer.sol#L108-L118


 - [ ] ID-46
[AuctionEngine.abandonLP(uint256)](./src/AuctionEngine.sol#L362-L378) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(! r.lpDone,LP already done)](./src/AuctionEngine.sol#L366)
	- [require(bool,string)(block.timestamp >= uint256(r.settledAt) + lpGracePeriod,grace period not over)](./src/AuctionEngine.sol#L367)

./src/AuctionEngine.sol#L362-L378


 - [ ] ID-47
[ExitAuction._sealTerms(uint256)](./src/exit/ExitAuction.sol#L185-L194) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.commitEnd != 0,unknown round)](./src/exit/ExitAuction.sol#L192)

./src/exit/ExitAuction.sol#L185-L194


 - [ ] ID-48
[DepositLedger.burnUnrevealed(uint256)](./src/DepositLedger.sol#L69-L80) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(block.timestamp >= _revealEndOf(roundId),reveal window open)](./src/DepositLedger.sol#L70)

./src/DepositLedger.sol#L69-L80


 - [ ] ID-49
[AuctionEngine.withdrawProceeds(uint256)](./src/AuctionEngine.sol#L573-L583) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(msg.sender == r.creator,not creator)](./src/AuctionEngine.sol#L575)
	- [require(bool,string)(r.lpDone,LP not done)](./src/AuctionEngine.sol#L576)

./src/AuctionEngine.sol#L573-L583


 - [ ] ID-50
[SealingLayer.commit(uint256,bytes32,bytes32[],bytes)](./src/SealingLayer.sol#L45-L64) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(block.timestamp < commitEnd,commit window closed)](./src/SealingLayer.sol#L51)

./src/SealingLayer.sol#L45-L64


 - [ ] ID-51
[ExitAuction.reservedShares()](./src/exit/ExitAuction.sol#L335-L339) uses timestamp for comparisons
	Dangerous comparisons:
	- [id != 0 && ! _books[id].settled](./src/exit/ExitAuction.sol#L338)

./src/exit/ExitAuction.sol#L335-L339


 - [ ] ID-52
[AuctionEngine._vestedAmount(AuctionEngine.Round,uint256)](./src/AuctionEngine.sol#L657-L664) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp <= start](./src/AuctionEngine.sol#L660)
	- [elapsed >= r.vestDuration](./src/AuctionEngine.sol#L662)

./src/AuctionEngine.sol#L657-L664


 - [ ] ID-53
[AuctionEngine.seedLP(uint256)](./src/AuctionEngine.sol#L344-L356) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(! r.lpDone,LP already done)](./src/AuctionEngine.sol#L348)

./src/AuctionEngine.sol#L344-L356


 - [ ] ID-54
[AuctionEngine.constructor(address,address[],uint256,uint256)](./src/AuctionEngine.sol#L182-L193) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(permanentLockEnd_ > block.timestamp,lock end in past)](./src/AuctionEngine.sol#L184)

./src/AuctionEngine.sol#L182-L193


 - [ ] ID-55
[AuctionEngine._validate(AuctionEngine.OpenParams)](./src/AuctionEngine.sol#L249-L288) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(p.commitEnd >= block.timestamp + MIN_COMMIT_WINDOW,commit window too short)](./src/AuctionEngine.sol#L260)

./src/AuctionEngine.sol#L249-L288


 - [ ] ID-56
[ExitAuction._quote(uint256,address)](./src/exit/ExitAuction.sol#L354-L369) uses timestamp for comparisons
	Dangerous comparisons:
	- [assets < atSettle](./src/exit/ExitAuction.sol#L366)

./src/exit/ExitAuction.sol#L354-L369


 - [ ] ID-57
[ExitAuction._refund(uint256,address)](./src/exit/ExitAuction.sol#L300-L306) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(_books[roundId].settled,not settled)](./src/exit/ExitAuction.sol#L301)

./src/exit/ExitAuction.sol#L300-L306


 - [ ] ID-58
[ExitAuction._exit(uint256,address)](./src/exit/ExitAuction.sol#L266-L297) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(r.allocatedTotal <= sold,over-allocated)](./src/exit/ExitAuction.sol#L276)
	- [require(bool,string)(r.allocatedTotal + r.returnedTotal <= r.escrowed,share accounting)](./src/exit/ExitAuction.sol#L277)
	- [r.exitsClaimed == ledgers[roundId].reveals](./src/exit/ExitAuction.sol#L284)
	- [alloc != 0](./src/exit/ExitAuction.sol#L287)
	- [require(bool,string)(got >= assets,redeem short)](./src/exit/ExitAuction.sol#L291)
	- [payout != 0](./src/exit/ExitAuction.sol#L292)
	- [toVault != 0](./src/exit/ExitAuction.sol#L294)
	- [back != 0](./src/exit/ExitAuction.sol#L296)

./src/exit/ExitAuction.sol#L266-L297


 - [ ] ID-59
[ExitAuction.openExitRound()](./src/exit/ExitAuction.sol#L152-L180) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(_books[prev].settled,previous round not settled)](./src/exit/ExitAuction.sol#L155)
	- [require(bool,string)(block.number >= uint256(_rounds[prev].settledBlock) + roundGapBlocks,too soon)](./src/exit/ExitAuction.sol#L156)
	- [capacity > maxExitSharesPerRound](./src/exit/ExitAuction.sol#L162)
	- [require(bool,string)(capacity != 0,no exit capacity)](./src/exit/ExitAuction.sol#L163)
	- [idle > owed](./src/exit/ExitAuction.sol#L160)

./src/exit/ExitAuction.sol#L152-L180


 - [ ] ID-60
[AuctionEngine._onReveal(uint256,address,uint96,uint96,uint256)](./src/AuctionEngine.sol#L307-L317) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(price % r.tickSize == 0 && price >= r.reservePrice,price off grid or below reserve)](./src/AuctionEngine.sol#L309)
	- [require(bool,string)(_mulDivUp(price,amount,PRICE_SCALE) < r.depositAmount,bid exceeds deposit)](./src/AuctionEngine.sol#L311)
	- [require(bool,string)(_mulDivUp(r.reservePrice,amount,PRICE_SCALE) >= r.minBidSize,below minimum bid)](./src/AuctionEngine.sol#L314)

./src/AuctionEngine.sol#L307-L317


## assembly
Impact: Informational
Confidence: High
 - [ ] ID-61
[DepositLedger._pushRefund(address,uint256)](./src/DepositLedger.sol#L99-L111) uses assembly
	- [INLINE ASM](./src/DepositLedger.sol#L103-L105)

./src/DepositLedger.sol#L99-L111


 - [ ] ID-62
[UniV3PriceMath.mulDiv(uint256,uint256,uint256)](./src/adapters/UniV3PriceMath.sol#L21-L59) uses assembly
	- [INLINE ASM](./src/adapters/UniV3PriceMath.sol#L27-L31)
	- [INLINE ASM](./src/adapters/UniV3PriceMath.sol#L38-L42)
	- [INLINE ASM](./src/adapters/UniV3PriceMath.sol#L44-L48)

./src/adapters/UniV3PriceMath.sol#L21-L59


