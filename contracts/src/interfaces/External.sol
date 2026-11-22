// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// TapeOut processor (TAP-02): circuits are NAND/LATCH netlists; eval and step are views.
interface ITapeoutProcessor {
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
    function step(uint256 id, bytes calldata state, bytes calldata inputs)
        external
        view
        returns (bytes memory newState, bytes memory outputs);
    function circuitInfo(uint256 id)
        external
        view
        returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
    function netlist(uint256 id) external view returns (bytes memory);
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256 id);
    function TAPEOUT_FEE() external view returns (uint256);
    function transistors() external view returns (address);
    function nextId() external view returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
}

interface ITapeoutFactory {
    function createCPU(string calldata name, string calldata symbol, string calldata story, uint256 supply, uint256 mintPrice)
        external
        payable
        returns (address transistors, address circuits);
    function deployFee() external view returns (uint256);
    function isCPU(address) external view returns (bool);
}

interface ITransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
}

interface IBeacon {
    function implementation() external view returns (address);
}

/// Chainlink data feed.
interface IAggregator {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// Uniswap v3 SwapRouter02 (no deadline in the struct: the router checks its own).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}
