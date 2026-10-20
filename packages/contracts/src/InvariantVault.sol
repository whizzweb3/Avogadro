// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal accounting target for deterministic invariant-test examples.
contract InvariantVault {
    mapping(address => uint256) public balanceOf;
    uint256 public totalDeposited;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalDeposited += msg.value;
    }

    function withdraw(uint256 amount) external {
        uint256 balance = balanceOf[msg.sender];
        require(amount <= balance, "insufficient balance");
        balanceOf[msg.sender] = balance - amount;
        totalDeposited -= amount;
        (bool sent,) = msg.sender.call{value: amount}("");
        require(sent, "transfer failed");
    }
}
