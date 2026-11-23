// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DarwinBasket} from "./DarwinBasket.sol";
import {DarwinGuard} from "./DarwinGuard.sol";
import {DarwinOracle} from "./DarwinOracle.sol";
import {ITapeoutProcessor} from "./interfaces/External.sol";

/// @title DarwinStudio
/// @notice Anyone designs a strategy and launches it as a basket, in one transaction.
///
/// The strategy is a methodology circuit (built in the browser from the creator's coins and
/// weights). The studio tapes it out on Darwin's TapeOut processor, checks on chain that the
/// circuit really is a methodology for those coins (weights summing to 100%, a band, nothing for
/// coins that are not there), deploys the basket and hands the creator the circuit's NFT. The
/// creator then owns the strategy: they earn a third of its fees and can propose a new methodology
/// behind the basket's 3-day timelock.
///
/// The studio holds a stock of transistors for this: a creator pays the processor's tape-out fee
/// and a small fee per gate (in OKB), plus gas.
contract DarwinStudio is ERC1155Holder, IERC721Receiver, ReentrancyGuard {
    ITapeoutProcessor public immutable processor;
    DarwinGuard public immutable guard;
    DarwinOracle public immutable oracle;
    address public immutable router;
    address public immutable treasury;

    uint256 public constant MAX_GATES = 400;
    uint8 public constant MAX_COINS = 8;

    address[] public baskets;
    mapping(address basket => bool) public isBasket;
    mapping(address basket => uint256) public circuitOf;

    event StrategyCreated(
        address indexed basket, address indexed creator, uint256 indexed circuitId, string name, string symbol, address[] coins
    );

    error BadCoins();
    error BadNetlist();
    error FeeTooLow(uint256 needed);
    error RefundFailed();

    constructor(DarwinGuard guard_, address router_, address treasury_) {
        guard = guard_;
        processor = guard_.processor();
        oracle = guard_.oracle();
        router = router_;
        treasury = treasury_;
    }

    function basketCount() external view returns (uint256) {
        return baskets.length;
    }

    function allBaskets() external view returns (address[] memory) {
        return baskets;
    }

    /// OKB per gate, paid to Darwin's treasury: the studio's transistors are a shared stock, and a
    /// few dollars must not be enough to empty it.
    uint256 public constant GATE_FEE = 0.00005 ether;

    /// The OKB a creator must send for a netlist of `gates` gates: the processor's tape-out fee and
    /// the gate fee.
    function launchFee(uint256 gates) public view returns (uint256) {
        return processor.TAPEOUT_FEE() + gates * GATE_FEE;
    }

    /// For a typical methodology (100 gates).
    function launchFee() external view returns (uint256) {
        return launchFee(100);
    }

    function createStrategy(string calldata name, string calldata symbol, address[] calldata coins, bytes calldata netlist)
        external
        payable
        nonReentrant
        returns (DarwinBasket basket)
    {
        if (coins.length == 0 || coins.length > MAX_COINS) revert BadCoins();
        for (uint256 i; i < coins.length; i++) {
            if (!oracle.listed(coins[i])) revert BadCoins();
        }
        // a methodology is NAND gates only (7 bytes each), small enough to stay cheap for buyers
        if (netlist.length == 0 || netlist.length % 7 != 0 || netlist.length / 7 > MAX_GATES) revert BadNetlist();
        for (uint256 k; k < netlist.length; k += 7) {
            if (netlist[k] != 0x00) revert BadNetlist();
        }
        uint256 fee = launchFee(netlist.length / 7);
        if (msg.value < fee) revert FeeTooLow(fee);

        uint256 id = processor.tapeout{value: processor.TAPEOUT_FEE()}(netlist, 4, 11);
        guard.checkWeights(id, coins.length);
        _pay(treasury, fee - processor.TAPEOUT_FEE());

        basket = new DarwinBasket(name, symbol, msg.sender, msg.sender, router, guard, coins, id, keccak256(netlist));
        baskets.push(address(basket));
        isBasket[address(basket)] = true;
        circuitOf[address(basket)] = id;
        IERC721(address(processor)).safeTransferFrom(address(this), msg.sender, id);
        emit StrategyCreated(address(basket), msg.sender, id, name, symbol, coins);

        if (msg.value > fee) _pay(msg.sender, msg.value - fee);
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}
