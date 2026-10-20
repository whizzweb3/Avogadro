// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev A tiny intentionally broken model used to prove the expected-failure
/// profile can replay a stable counterexample. This is not an AVOGADRO finding.
contract ReplayCounterexampleTest {
    uint256 private value;

    function test_replayCounterexample() public {
        value = 1;
        value = 0; // replayed transition violates the deliberately false property
        assert(value == 1);
    }
}
