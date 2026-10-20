// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev A tiny intentionally broken model used to prove stateful invariant
/// replay can preserve a failing call sequence. This is not an AVOGADRO finding.
contract ReplayCounterexampleHandler {
    uint256 public value;

    function increment(uint8 amount) external {
        value += uint256(amount) + 1;
    }
}

contract ReplayCounterexampleTest {
    ReplayCounterexampleHandler private handler;

    function setUp() public {
        handler = new ReplayCounterexampleHandler();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// @dev The first generated state transition violates the intentionally false property.
    function invariant_replayValueRemainsZero() public view {
        assert(handler.value() == 0);
    }
}
