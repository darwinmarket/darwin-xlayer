// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DarwinBasket} from "./DarwinBasket.sol";
import {DarwinGuard} from "./DarwinGuard.sol";
import {DarwinOracle} from "./DarwinOracle.sol";
import {ISwapRouter02} from "./interfaces/External.sol";

/// @title DarwinRouter
/// @notice Buy or sell a whole basket in one transaction, through Uniswap v3 on X Layer.
///
/// Buy: stablecoin in, every coin bought on its pool (new money goes to the coins furthest under
/// their target), the coins land in the basket, shares are minted to the buyer.
/// Sell: shares redeemed in kind, every coin sold on its pool, stablecoin out.
///
/// Nobody holds the user's funds between steps: it all happens in the user's own transaction and
/// reverts as a whole. Every leg of every trade is judged by Darwin's trade-policy circuit on
/// TapeOut, with the real execution price, the oracle's age and the basket's weights after the
/// trade; one refused leg reverts the trade. A tripped breaker closes buying; selling and
/// redeeming in kind stay open.
contract DarwinRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    DarwinGuard public immutable guard;
    DarwinOracle public immutable oracle;
    ISwapRouter02 public immutable swapRouter;
    address public immutable treasury;
    address public immutable quote;

    uint256 public constant FEE_BPS = 30; // 0.30% on buys and sells
    uint256 public constant BPS = 10_000;

    struct Verdict {
        address coin;
        uint256 amountIn;
        uint256 amountOut;
        uint8 dev;
        uint8 drift;
        uint8 severity;
    }

    event Bought(
        address indexed basket, address indexed buyer, address payToken, uint256 amountIn, uint256 shares, uint256 fee
    );
    event Sold(
        address indexed basket, address indexed seller, address payToken, uint256 shares, uint256 amountOut, uint256 fee
    );
    /// One per leg: what the trade-policy circuit was asked and what it answered.
    event Leg(address indexed basket, address indexed coin, bool isBuy, uint8 dev, uint8 age, uint8 drift, bool better, uint8 severity);

    error Expired();
    error BuyingClosed(address basket);
    error Refused(address coin, uint8 severity, uint8 dev, uint8 drift);
    error NoEligibleCoin();
    error Slippage(uint256 got, uint256 min);
    error ZeroAmount();

    constructor(DarwinGuard guard_, ISwapRouter02 swapRouter_, address treasury_) {
        guard = guard_;
        oracle = guard_.oracle();
        swapRouter = swapRouter_;
        treasury = treasury_;
        quote = oracle.quote();
    }

    // ---- buy -------------------------------------------------------------------------------------

    function buy(DarwinBasket basket, address payToken, uint256 amountIn, uint256 minShares, uint256 deadline, address to)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        if (!guard.buyOpen(address(basket))) revert BuyingClosed(address(basket));
        IERC20(payToken).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 q = payToken == quote ? amountIn : _swapLeg(address(basket), payToken, quote, amountIn, true, 0, true, address(this));
        uint256 fee = q * FEE_BPS / BPS;
        IERC20(quote).safeTransfer(treasury, fee);
        q -= fee;

        uint256 supply = basket.totalSupply();
        uint256 navBefore = basket.nav();
        address[] memory coins = basket.coinList();
        uint256[] memory before = _values(basket, coins);
        (uint256[] memory t,) = basket.targets();
        uint256[] memory alloc = allocate(before, t, q, oracle.value(quote, q));

        uint256[] memory got = new uint256[](coins.length);
        for (uint256 i; i < coins.length; i++) {
            if (alloc[i] == 0) continue;
            if (coins[i] == quote) {
                IERC20(quote).safeTransfer(address(basket), alloc[i]);
                got[i] = alloc[i];
            } else {
                got[i] = _swap(quote, coins[i], alloc[i], _minOut(quote, coins[i], alloc[i], 8), address(basket));
            }
        }

        // judge every leg with the basket's weights after the trade
        uint256 valueIn;
        uint256[] memory afterV = new uint256[](coins.length);
        for (uint256 i; i < coins.length; i++) {
            uint256 v = oracle.value(coins[i], got[i]);
            valueIn += v;
            afterV[i] = before[i] + v;
        }
        _judgeBuy(address(basket), coins, alloc, got, before, afterV, t);

        // the new money is worth what it bought at the oracle, never more than what was paid
        uint256 paid = oracle.value(quote, q);
        if (valueIn > paid) valueIn = paid;
        shares = Math.mulDiv(valueIn, supply, navBefore);
        if (shares < minShares) revert Slippage(shares, minShares);
        basket.mint(to, shares);
        emit Bought(address(basket), msg.sender, payToken, amountIn, shares, fee);
    }

    function _judgeBuy(
        address basket,
        address[] memory coins,
        uint256[] memory alloc,
        uint256[] memory got,
        uint256[] memory before,
        uint256[] memory afterV,
        uint256[] memory t
    ) internal {
        uint256 totalBefore;
        uint256 totalAfter;
        for (uint256 i; i < coins.length; i++) {
            totalBefore += before[i];
            totalAfter += afterV[i];
        }
        bool seqUp = oracle.sequencerUp();
        for (uint256 i; i < coins.length; i++) {
            if (alloc[i] == 0) continue;
            uint256 wAfter = afterV[i] * BPS / totalAfter;
            uint256 dAfter = _absDiff(wAfter, t[i]);
            bool better = totalBefore == 0 || dAfter <= _absDiff(before[i] * BPS / totalBefore, t[i]);
            uint8 dev = coins[i] == quote ? 0 : _execDev(quote, coins[i], alloc[i], got[i]);
            _judge(basket, coins[i], dev, oracle.ageClass(coins[i]), seqUp, true, _pp(dAfter), better);
        }
    }

    // ---- sell ------------------------------------------------------------------------------------

    function sell(DarwinBasket basket, uint256 shares, address payToken, uint256 minOut, uint256 deadline, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        if (shares == 0) revert ZeroAmount();
        IERC20(address(basket)).safeTransferFrom(msg.sender, address(this), shares);
        address[] memory coins = basket.coinList();
        // a pro-rata exit leaves the weights as they are: report each coin's current drift
        uint256[] memory v = _values(basket, coins);
        (uint256[] memory t,) = basket.targets();
        uint256 total;
        for (uint256 i; i < coins.length; i++) {
            total += v[i];
        }
        uint256[] memory amounts = basket.redeem(shares, address(this));

        uint256 q;
        for (uint256 i; i < coins.length; i++) {
            if (amounts[i] == 0) continue;
            uint8 drift = total == 0 ? 0 : _pp(_absDiff(v[i] * BPS / total, t[i]));
            if (coins[i] == quote) {
                q += amounts[i];
            } else {
                q += _swapLeg(address(basket), coins[i], quote, amounts[i], false, drift, true, address(this));
            }
        }
        uint256 fee = q * FEE_BPS / BPS;
        IERC20(quote).safeTransfer(treasury, fee);
        q -= fee;
        out = payToken == quote ? q : _swapLeg(address(basket), quote, payToken, q, false, 0, true, address(this));
        if (out < minOut) revert Slippage(out, minOut);
        IERC20(payToken).safeTransfer(to, out);
        emit Sold(address(basket), msg.sender, payToken, shares, out, fee);
    }

    // ---- allocation ------------------------------------------------------------------------------

    /// Split `q` quote units (worth `qUsd`) over the coins: first fill the coins under their target
    /// after the trade, in proportion to how far under they are; whatever is left follows the targets.
    function allocate(uint256[] memory valuesUsd, uint256[] memory t, uint256 q, uint256 qUsd)
        public
        pure
        returns (uint256[] memory alloc)
    {
        uint256 n = valuesUsd.length;
        alloc = new uint256[](n);
        uint256 total = qUsd;
        uint256 tSum;
        for (uint256 i; i < n; i++) {
            total += valuesUsd[i];
            tSum += t[i];
        }
        if (tSum == 0) revert NoEligibleCoin();
        uint256[] memory deficit = new uint256[](n);
        uint256 dSum;
        for (uint256 i; i < n; i++) {
            uint256 target = total * t[i] / tSum;
            if (t[i] > 0 && target > valuesUsd[i]) {
                deficit[i] = target - valuesUsd[i];
                dSum += deficit[i];
            }
        }
        uint256 given;
        uint256 last;
        for (uint256 i; i < n; i++) {
            if (t[i] == 0) continue;
            last = i;
            if (dSum >= qUsd) {
                alloc[i] = Math.mulDiv(q, deficit[i], dSum);
            } else {
                uint256 dQ = Math.mulDiv(q, deficit[i], qUsd);
                alloc[i] = dQ + Math.mulDiv(q - Math.mulDiv(q, dSum, qUsd), t[i], tSum);
            }
            given += alloc[i];
        }
        if (given < q) alloc[last] += q - given; // rounding dust
        else if (given > q) alloc[last] -= given - q;
    }

    // ---- legs ------------------------------------------------------------------------------------

    function _swapLeg(
        address basket,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool isBuy,
        uint8 drift,
        bool better,
        address recipient
    ) internal returns (uint256 out) {
        out = _swap(tokenIn, tokenOut, amountIn, _minOut(tokenIn, tokenOut, amountIn, isBuy ? 8 : 12), recipient);
        address coin = tokenIn == quote ? tokenOut : tokenIn;
        _judge(basket, coin, _execDev(tokenIn, tokenOut, amountIn, out), oracle.ageClass(coin), oracle.sequencerUp(), isBuy, drift, better);
    }

    function _judge(address basket, address coin, uint8 dev, uint8 age, bool seqUp, bool isBuy, uint8 drift, bool better)
        internal
    {
        DarwinGuard.Leg memory l = DarwinGuard.Leg(dev, age, seqUp, isBuy, drift, better);
        (bool allow, uint8 severity) = guard.policy(l);
        if (!allow) revert Refused(coin, severity, dev, drift);
        emit Leg(basket, coin, isBuy, dev, age, drift, better, severity);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        internal
        returns (uint256)
    {
        address coin = tokenIn == quote ? tokenOut : tokenIn;
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
        return swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: oracle.market(coin).fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// The oracle's amount out, less `steps` x 0.25%: the most a pool may cost before the swap
    /// itself reverts (the circuit then judges the real price).
    function _minOut(address tokenIn, address tokenOut, uint256 amountIn, uint256 steps) internal view returns (uint256) {
        uint256 fair = oracle.amountFor(tokenOut, oracle.value(tokenIn, amountIn));
        return fair * (400 - steps) / 400;
    }

    /// |execution price - oracle price| in 0.25% steps, from what went in and what came out.
    function _execDev(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) internal view returns (uint8) {
        uint256 fair = oracle.amountFor(tokenOut, oracle.value(tokenIn, amountIn));
        if (fair == 0) return 15;
        return oracle.deviationSteps(amountOut, fair);
    }

    function _values(DarwinBasket basket, address[] memory coins) internal view returns (uint256[] memory v) {
        uint256[] memory b = basket.balances();
        v = new uint256[](coins.length);
        for (uint256 i; i < coins.length; i++) {
            v[i] = oracle.value(coins[i], b[i]);
        }
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /// Basis points to whole percentage points, saturating at 15.
    function _pp(uint256 bps) internal pure returns (uint8) {
        uint256 pp = bps / 100;
        return pp > 15 ? 15 : uint8(pp);
    }
}
