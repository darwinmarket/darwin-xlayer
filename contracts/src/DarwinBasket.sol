// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DarwinGuard} from "./DarwinGuard.sol";
import {DarwinOracle} from "./DarwinOracle.sol";

/// @title DarwinBasket
/// @notice One token, a whole strategy: an ERC-20 share fully backed by the coins it holds.
///
/// - Only the router mints, after handing the coins in (a whole basket bought in one transaction).
///   The very first buy also mints $1 of shares to DEAD, never redeemable (protects the share price).
/// - Anyone redeems at any time, in kind: shares are burnt and every coin is paid out pro rata.
///   No breaker, circuit or admin can stop an exit.
/// - The target weights are a TapeOut circuit (the methodology). The owner (the strategy's
///   creator) can propose a new one; it applies only after a public 3-day timelock, and its
///   netlist hash is pinned when proposed. The creator earns a share of the basket's fees.
contract DarwinBasket is ERC20, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable router;
    /// Who designed the strategy: receives the creator's share of every fee.
    address public immutable creator;
    DarwinGuard public immutable guard;
    DarwinOracle public immutable oracle;

    uint256 public constant TIMELOCK = 3 days;
    uint8 public constant MAX_COINS = 8;
    /// The first buy's $1 of shares go here, where nobody can redeem them.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address[] internal coins;
    uint256 public methodologyId;
    bytes32 public methodologyHash;
    uint256 public pendingId;
    bytes32 public pendingHash;
    uint256 public pendingEta;
    event Minted(address indexed to, uint256 shares);
    event Redeemed(address indexed from, address indexed to, uint256 shares, uint256[] amounts);
    event MethodologyProposed(uint256 id, bytes32 hash, uint256 eta);
    event MethodologyApplied(uint256 id, bytes32 hash);

    error NotRouter();
    error BadCoins();
    error ZeroShares();
    error NoPending();
    error TimelockActive(uint256 eta);

    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        address creator_,
        address router_,
        DarwinGuard guard_,
        address[] memory coins_,
        uint256 methodologyId_,
        bytes32 methodologyHash_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        if (coins_.length == 0 || coins_.length > MAX_COINS) revert BadCoins();
        router = router_;
        creator = creator_;
        guard = guard_;
        oracle = guard_.oracle();
        for (uint256 i; i < coins_.length; i++) {
            oracle.market(coins_[i]); // reverts for a coin the oracle does not price
            for (uint256 j; j < i; j++) {
                if (coins_[j] == coins_[i]) revert BadCoins();
            }
            coins.push(coins_[i]);
        }
        guard_.checkMethodology(methodologyId_, methodologyHash_);
        methodologyId = methodologyId_;
        methodologyHash = methodologyHash_;
    }

    // ---- views -----------------------------------------------------------------------------------

    function coinList() external view returns (address[] memory) {
        return coins;
    }

    function coinCount() external view returns (uint256) {
        return coins.length;
    }

    function balances() public view returns (uint256[] memory b) {
        b = new uint256[](coins.length);
        for (uint256 i; i < coins.length; i++) {
            b[i] = IERC20(coins[i]).balanceOf(address(this));
        }
    }

    /// USD value of everything the basket holds, 18 decimals (Chainlink).
    function nav() public view returns (uint256 usd) {
        uint256[] memory b = balances();
        for (uint256 i; i < coins.length; i++) {
            usd += oracle.value(coins[i], b[i]);
        }
    }

    /// The methodology circuit's targets, in basis points over the eligible coins, and its band.
    /// An ineligible coin (stale feed or pool off its oracle) gets 0 and its share goes to the
    /// others in proportion. If no coin is eligible, every target is 0.
    function targets() public view returns (uint256[] memory bps, uint8 band) {
        bps = new uint256[](coins.length);
        uint256 sum;
        for (uint256 i; i < coins.length; i++) {
            (uint8 w, uint8 b) = guard.methodology(methodologyId, uint8(i), guard.eligible(coins[i]));
            bps[i] = w;
            sum += w;
            band = b;
        }
        if (sum == 0) return (bps, band);
        uint256 assigned;
        uint256 last;
        for (uint256 i; i < coins.length; i++) {
            if (bps[i] == 0) continue;
            bps[i] = bps[i] * 10_000 / sum;
            assigned += bps[i];
            last = i;
        }
        bps[last] += 10_000 - assigned; // rounding dust to the last eligible coin
    }

    // ---- mint, redeem ----------------------------------------------------------------------

    /// The router mints after it has transferred the coins in.
    function mint(address to, uint256 shares) external {
        if (msg.sender != router) revert NotRouter();
        if (shares == 0) revert ZeroShares();
        _mint(to, shares);
        emit Minted(to, shares);
    }

    /// Burn `shares` of the caller and pay every coin out pro rata to `to`. Always open.
    function redeem(uint256 shares, address to) external nonReentrant returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroShares();
        uint256 supply = totalSupply();
        amounts = balances();
        _burn(msg.sender, shares);
        for (uint256 i; i < coins.length; i++) {
            amounts[i] = amounts[i] * shares / supply;
            if (amounts[i] > 0) IERC20(coins[i]).safeTransfer(to, amounts[i]);
        }
        emit Redeemed(msg.sender, to, shares, amounts);
    }

    // ---- methodology -----------------------------------------------------------------------------

    function proposeMethodology(uint256 id, bytes32 hash) external onlyOwner {
        guard.checkMethodology(id, hash);
        pendingId = id;
        pendingHash = hash;
        pendingEta = block.timestamp + TIMELOCK;
        emit MethodologyProposed(id, hash, pendingEta);
    }

    /// Anyone applies a proposed methodology once its timelock has passed.
    function applyMethodology() external {
        if (pendingEta == 0) revert NoPending();
        if (block.timestamp < pendingEta) revert TimelockActive(pendingEta);
        guard.checkMethodology(pendingId, pendingHash);
        methodologyId = pendingId;
        methodologyHash = pendingHash;
        pendingEta = 0;
        emit MethodologyApplied(methodologyId, methodologyHash);
    }
}
