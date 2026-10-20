// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {InvariantVault} from "../../src/InvariantVault.sol";

interface Vm {
    function deal(address account, uint256 balance) external;
}

contract VaultHandler {
    InvariantVault public immutable vault;
    address[3] private actors;
    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;

    constructor(InvariantVault vault_) {
        vault = vault_;
        actors = [address(0xA11CE), address(0xB0B), address(0xCAFE)];
    }

    function deposit(uint8 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 amount = uint256(amountSeed) % 1 ether;
        Vm(address(uint160(uint256(keccak256("hevm cheat code"))))).deal(actor, 10 ether);
        (bool ok,) = actor.call{value: amount}(abi.encodeCall(vault.deposit, ()));
        if (ok) ghostDeposited += amount;
    }

    function withdraw(uint8 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 available = vault.balanceOf(actor);
        if (available == 0) return;
        uint256 amount = uint256(amountSeed) % (available + 1);
        (bool ok,) = actor.call(abi.encodeCall(vault.withdraw, (amount)));
        if (ok) ghostWithdrawn += amount;
    }
}

contract VaultInvariantTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    InvariantVault private vault;
    VaultHandler private handler;

    function setUp() public {
        vault = new InvariantVault();
        handler = new VaultHandler(vault);
    }

    /// @dev Foundry discovers invariant targets through this convention.
    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_accountingMatchesSuccessfulActions() public view {
        assert(vault.totalDeposited() == handler.ghostDeposited() - handler.ghostWithdrawn());
        assert(address(vault).balance == vault.totalDeposited());
    }
}
