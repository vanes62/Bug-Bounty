const { expect, assert } = require("chai");
const { constants, utils, BigNumber } = require("ethers");
const { ethers, network } = require("hardhat");
const {
  getRandomConditionId,
  getBlockTime,
  timeShift,
  timeShiftBy,
  tokens,
  getTokenId,
  getTokenIdOdds,
  getConditioIdHash,
  getLPNFTToken,
  tokensDec,
  prepareStand,
} = require("../utils/utils");
const dbg = require("debug")("test:core");

const CONDITION_START = 13253453;
const LIQUIDITY = tokens(2000000);
const LIQUIDITY_PLUS_1 = tokens(2000001);
const LIQUIDITY_ONE_TOKEN = tokens(1);
const ONE_HOUR = 3600;
const ONE_WEEK = 604800;
const TWO_WEEKS = 1209600;
const SCOPE_ID = 1;
const OUTCOMEWIN = 1;
const OUTCOMELOSE = 2;
const OUTCOMEINCORRECT = 3;
const FEEHALFPERCENT = 5000000;
const FEE1PERCENT = 10000000;
const FEE5PERCENT = 50000000;
const FEE9PERCENT = 90000000;
const WITHDRAW_100_PERCENT = 1000000000000;

let conditionArr = [];

const createCondition = async (core, oracle, condID, scopeID, pools, outcomes, time, ipfsHash) => {
  let txCreate = await core
    .connect(oracle)
    .createCondition(condID, scopeID, pools, outcomes, time, ethers.utils.formatBytes32String(ipfsHash));

  let condIDHash = await getConditioIdHash(txCreate);
  conditionArr.push([oracle, condID, condIDHash]);
  return condIDHash;
};

const makeBetGetTokenId = async (lp, user, condIDHash, betAmount, outcome, deadline, minrate) => {
  let txBet = await lp.connect(user).bet(condIDHash, betAmount, outcome, deadline, minrate);
  let res = await getTokenId(txBet);
  return res;
};

const makeBetGetTokenIdOdds = async (lp, user, condIDHash, betAmount, outcome, deadline, minrate) => {
  let txBet = await lp.connect(user).bet(condIDHash, betAmount, outcome, deadline, minrate);
  let res = await getTokenIdOdds(txBet);
  return { tokenId: res.tokenId, odds: res.odds };
};

describe("Core test", function () {
  let owner, adr1, lpOwner, oracle, oracle2, maintainer;
  let Core, core, core2, Usdt, usdt, LP, lp;
  let lpNFT;

  const reinforcement = constants.WeiPerEther.mul(20000); // 10%
  const marginality = 50000000; // 5%

  let condID = CONDITION_START;
  const pool1 = 5000000;
  const pool2 = 5000000;

  before(async () => {
    [owner, adr1, lpOwner, oracle, oracle2, maintainer] = await ethers.getSigners();

    [core, core2, usdt, lp] = await prepareStand(
      ethers,
      owner,
      adr1,
      oracle,
      oracle2,
      maintainer,
      reinforcement,
      marginality,
      LIQUIDITY
    );

    lpNFT = await getLPNFTToken(await lp.addLiquidity(tokens(1)));
  });
  it("Check oracle", async () => {
    expect(await core.isOracle(oracle.address)).to.be.equal(true);
    expect(await core.isOracle(maintainer.address)).to.be.equal(false);
  });

  it("try withdraw liquidity without not existent LPNFT", async () => {
    await expect(lp.withdrawLiquidity(100, WITHDRAW_100_PERCENT)).to.be.revertedWith(
      "ERC721: owner query for nonexistent token"
    );
  });

  it("try withdraw liquidity without not not owned LPNFT", async () => {
    await expect(lp.connect(adr1).withdrawLiquidity(lpNFT, WITHDRAW_100_PERCENT)).to.be.revertedWith(
      "LiquidityNotOwned"
    );
  });

  it("upgrade works", async () => {
    const CoreV2 = await ethers.getContractFactory("Core");
    const upgraded = await upgrades.upgradeProxy(core.address, CoreV2);
    expect(await upgraded.oracles(oracle.address)).to.equal(true);
  });

  it("Should calculate margin", async function () {
    var a = await core.marginAdjustedOdds(1730000000, 50000000, 1e9);
    dbg("1.73 with 5% newOdds = ", utils.formatUnits(a, 9));
    expect(a).to.equal(1658829423);

    a = await core.marginAdjustedOdds(1980000000, 50000000, 1e9);
    dbg("1.98 with 5% newOdds = ", utils.formatUnits(a, 9));
    expect(a).to.equal(1886657619);

    a = await core.marginAdjustedOdds(1980000000, 100000000, 1e9);
    dbg("1.98 with 10% newOdds = ", utils.formatUnits(a, 9));
    expect(a).to.equal(1801801818);
  });

  it("Should calculate rates", async function () {
    // getOddsFromBanks must be without marginality
    var a = await core.getOddsFromBanks(1500000000, 3000000000, 100000, 0 /*outcome index*/, 50000000, 1e9);
    dbg(
      "1.73 for 3.0 Bet outcome1 = %s with 5% newOdds = %s, (bank1=%s bank2=%s)",
      100000,
      utils.formatUnits(a, 9),
      1730000000,
      3000000000
    );
    expect(a).to.equal(2787053105);

    a = await core.getOddsFromBanks(50000000, 50000000, 100000, 0 /*outcome index*/, 50000000, 1e9);
    dbg(
      "1 for 1 Bet outcome1 = %s with 5% newOdds = %s, (bank1=%s bank2=%s)",
      100000,
      utils.formatUnits(a, 9),
      50000000,
      50000000
    );
    expect(a).to.equal(1904761904);

    a = await core.getOddsFromBanks(50000000, 50000000, 25000000, 0 /*outcome index*/, 50000000, 1e9);
    dbg(
      "1 for 1 Bet outcome1 = %s with 5% newOdds = %s (bank1=%s bank2=%s)",
      25000000,
      utils.formatUnits(a, 9),
      50000000,
      50000000
    );
    expect(a).to.equal(1610952313);
  });

  describe("Should go through betting extending limits", async function () {
    let time, deadline, minrate, outcomeWin, txCreate, condIDHash;
    let betAmount = constants.WeiPerEther.mul(100);
    beforeEach(async function () {
      // create condition
      time = await getBlockTime(ethers);
      condID++;

      condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      /* let approveAmount = constants.WeiPerEther.mul(9999999);
      await usdt.approve(lp.address, approveAmount); */
    });
    it("Should except deadline outdated", async function () {
      deadline = time - 10;
      minrate = 0;
      await expect(
        lp["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, betAmount, OUTCOMEWIN, deadline, minrate)
      ).to.be.revertedWith("ConditionStarted");
    });
    it("Should except minrate extended", async function () {
      deadline = time + 10;
      minrate = 9000000000;
      await expect(
        lp["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, betAmount, OUTCOMEWIN, deadline, minrate)
      ).to.be.revertedWith("SmallOdds");
    });
    it("Should except BIG_DIFFERENCE extended", async function () {
      // get more liquidity
      await usdt.mint(owner.address, tokens(200_000_000));
      await lp.addLiquidity(tokens(100_000_000));
      await expect(
        lp
          .connect(owner)
          ["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, tokens(100_000_000), OUTCOMEWIN, time + 10, minrate)
      ).to.be.revertedWith("BigDifference");

      // change MaxBanksRatio and make bet successfully
      await expect(core.changeMaxBanksRatio(10002)).to.be.revertedWith("OnlyMaintainer");

      // change MaxBanksRatio and make bet successfully
      await core.connect(maintainer).changeMaxBanksRatio(10002);

      let tokenId = await makeBetGetTokenId(
        lp,
        owner,
        condIDHash,
        tokens(100_000_000),
        OUTCOMEWIN,
        time + 10,
        0,
        lp.address
      );

      let tokensList = await azurobet.getTokensByOwner(owner.address);
      expect(tokensList[tokensList.length - 1]).to.be.equal(tokenId);
      // unused funciton tokenByIndex test
      expect(await azurobet.tokenByIndex(0)).to.be.equal(1);

      expect(await azurobet.tokenOfOwnerByIndex(owner.address, tokensList.length - 1)).to.be.equal(tokenId);

      const URI = "https://smth.com/";
      await azurobet.setBaseURI(URI);
      expect(await azurobet.tokenURI(tokenId)).to.be.equal(URI + tokenId);

      await expect(azurobet.burn(tokenId)).to.be.revertedWith("OnlyLp()");

      // clear up reserves
      await timeShiftBy(ethers, ONE_HOUR);
      await core.connect(oracle).resolveCondition(condID, OUTCOMEWIN);
      await lp.withdrawPayout(tokenId);
      // try resolve again
      await expect(core.connect(oracle).resolveCondition(condID, OUTCOMEWIN)).to.be.revertedWith(
        "ConditionAlreadyResolved()"
      );
    });
  });

  it("Should go through betting workflow with 2 users", async function () {
    const betAmount = constants.WeiPerEther.mul(100);
    const betAmount2 = constants.WeiPerEther.mul(100);
    time = await getBlockTime(ethers);

    //  EVENT: create condition
    condID++;

    let condIDHash = await createCondition(
      core,
      oracle,
      condID,
      SCOPE_ID,
      [pool2, pool1],
      [OUTCOMEWIN, OUTCOMELOSE],
      time + ONE_HOUR,
      "ipfs"
    );

    let deadline = time + 10;
    let minrate = await core.calculateOdds(condIDHash, betAmount, OUTCOMEWIN);
    let incorrect_minrate = (await core.calculateOdds(condIDHash, betAmount, OUTCOMEWIN)).add(1);

    await expect(
      lp["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, betAmount, OUTCOMEWIN, deadline, incorrect_minrate)
    ).revertedWith("SmallOdds"); // ODDS_TOO_SMALL

    let txBet1 = await lp["bet(uint256,uint128,uint64,uint64,uint64)"](
      condIDHash,
      betAmount,
      OUTCOMEWIN,
      deadline,
      minrate
    );

    // accepted bet returns "event NewBet(bytes32 indexed id, uint outcome, uint amount, uint odds);"

    let _res = await getTokenIdOdds(txBet1);
    let tokenId1 = _res.tokenId;
    let rate1 = _res.odds;

    expect((await azurobet.balanceOf(owner.address)).toString()).to.equal("1");
    await azurobet.connect(owner).transferFrom(owner.address, adr1.address, tokenId1);
    expect((await azurobet.balanceOf(adr1.address)).toString()).to.equal("1");

    //  EVENT: second player put the bet
    let txBet2 = await lp.connect(adr1).bet(condIDHash, betAmount2, OUTCOMELOSE, deadline, minrate);

    let tokenId2 = await getTokenId(txBet2);

    await timeShift(time + 9000);
    // resolve condition by oracle
    await core.connect(oracle).resolveCondition(condID, OUTCOMEWIN);

    //  EVENT: first player get his payout
    const better1OldBalance = await usdt.balanceOf(owner.address);
    await azurobet.setApprovalForAll(lp.address, true);

    // try to withdraw stake #1 (adr1 hold it now)
    await expect(lp.withdrawPayout(tokenId1)).to.be.revertedWith("OnlyBetOwner");

    // transfer back to owner
    expect((await azurobet.balanceOf(adr1.address)).toString()).to.equal("2");
    await azurobet.connect(adr1).transferFrom(adr1.address, owner.address, tokenId1);
    expect((await azurobet.balanceOf(owner.address)).toString()).to.equal("1");

    // try to withdraw stake #1 from owner - must be ok
    await lp.withdrawPayout(tokenId1);
    const better1NewBalance = await usdt.balanceOf(owner.address);

    expect((await azurobet.balanceOf(adr1.address)).toString()).to.equal("1");
    expect((await azurobet.balanceOf(owner.address)).toString()).to.equal("1"); // no NFT burn

    // NFT not burns - try to withdraw again, must be reverted
    await expect(lp.withdrawPayout(tokenId1)).to.be.revertedWith("NoWinNoPrize");

    let better1OldBalance_plus_calculation = better1OldBalance
      .add(BigNumber.from(rate1).mul(BigNumber.from(betAmount).div(BigNumber.from(1000000000))))
      .toString();
    expect(better1OldBalance_plus_calculation).to.equal(better1NewBalance);

    // if second player go for payout he does not got anything because he lose the bet
    let token2Payout = await lp.viewPayout(tokenId2);
    dbg("payouts for token2 isWin =", token2Payout[0], "Payout value", token2Payout[1].toString());

    await expect(lp.connect(adr1).withdrawPayout(tokenId2)).to.be.revertedWith("NoWinNoPrize");
  });
  describe("Outcomes dependencies", () => {
    it("Should create conditions with correct outcomes dependencies", async () => {
      let time, condIDHash;
      for (let outcomeID = 1; outcomeID < 10; outcomeID += 2) {
        time = await getBlockTime(ethers);
        condID++;

        condIDHash = await createCondition(
          core,
          oracle,
          condID,
          SCOPE_ID,
          [pool2, pool1],
          [outcomeID, outcomeID + 1],
          time + ONE_HOUR,
          "ipfs"
        );
        expect(await core.getConditionReinforcement(condIDHash)).to.be.equal(await core.getReinforcement(outcomeID));
        // unresolved conditions with uncommon outcomes may cause errors in future tests
        timeShift(time + ONE_HOUR);
        await core.connect(oracle).resolveCondition(condID, outcomeID);
      }
    });
    it("Should return default dependencies if outcomeID dependencies are unknown", async () => {
      time = await getBlockTime(ethers);
      const unknownOutcomeID = 999;
      condID++;

      await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      expect(await core.getReinforcement(unknownOutcomeID)).to.be.equal(reinforcement);
      expect(await core.getMargin(unknownOutcomeID)).to.be.equal(marginality);
    });

    it("Should correct update outcomes dependencies", async () => {
      time = await getBlockTime(ethers);
      const newReinforcement = reinforcement.div(10);
      const newMarginality = marginality / 10;
      condID++;

      await core
        .connect(maintainer)
        .updateReinforcements([OUTCOMEWIN, newReinforcement, OUTCOMELOSE, newReinforcement]);
      await expect(
        core.connect(maintainer).updateMargins([OUTCOMEWIN, newMarginality, OUTCOMELOSE])
      ).to.be.revertedWith("WrongDataFormat");
      await core.connect(maintainer).updateMargins([OUTCOMEWIN, newMarginality, OUTCOMELOSE, newMarginality]);

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );
      expect(await core.getConditionReinforcement(condIDHash)).to.be.equal(newReinforcement);
      expect(await core.getMargin(OUTCOMEWIN)).to.be.equal(newMarginality);
    });
  });
  describe("Check restrictions", () => {
    //Only Oracle create
    it("Should NOT create condition from not oracle", async () => {
      try {
        time = await getBlockTime(ethers);
        condID++;

        await core
          .connect(adr1)
          .createCondition(
            condID,
            SCOPE_ID,
            [pool2, pool1],
            [OUTCOMEWIN, OUTCOMELOSE],
            time + ONE_HOUR,
            ethers.utils.formatBytes32String("ipfs")
          );
        throw new Error("Success transaction from not oracle");
      } catch (e) {
        assert(e.message.includes("OnlyOracle"), e.message);
      }
    });

    //Non zero timestamp
    it("Should NOT create condition that is already started", async () => {
      try {
        time = await getBlockTime(ethers);
        condID++;

        await core
          .connect(oracle)
          .createCondition(
            condID,
            SCOPE_ID,
            [pool2, pool1],
            [OUTCOMEWIN, OUTCOMELOSE],
            time,
            ethers.utils.formatBytes32String("ipfs")
          );
        throw new Error("Success transaction with zero time");
      } catch (e) {
        assert(e.message.includes("IncorrectTimestamp"), e.message);
      }
    });

    //Resolve only created
    it("Should NOT resolve condition than not been created before", async () => {
      try {
        condID++;
        await core.connect(oracle).resolveCondition(condID, OUTCOMEWIN);
        throw new Error("Success resolve transaction for unknown condition");
      } catch (e) {
        assert(e.message.includes("ConditionNotExists"), e.message);
      }
    });

    //Only oracle resolve
    it("Should NOT resolve condition from not oracle", async () => {
      time = await getBlockTime(ethers);
      condID++;

      await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      try {
        await core.connect(adr1).resolveCondition(condID, OUTCOMEWIN);
        throw new Error("Success transaction from not oracle");
      } catch (e) {
        assert(e.message.includes("OnlyOracle"), e.message);
      }
    });
    it("Should NOT resolve condition with incorrect outcome", async () => {
      time = await getBlockTime(ethers);
      condID++;

      await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      await timeShift(time + ONE_HOUR);
      await expect(core.connect(oracle).resolveCondition(condID, OUTCOMEINCORRECT)).to.be.revertedWith("WrongOutcome");
    });
    it("Should NOT take bet with incorrect outcome stake", async () => {
      time = await getBlockTime(ethers);
      condID++;

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      await expect(
        lp["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, tokens(100), OUTCOMEINCORRECT, time + 100, 0)
      ).to.be.revertedWith("WrongOutcome");
    });
    it("Should return condition funds from getConditionFunds view", async () => {
      time = await getBlockTime(ethers);
      condID++;

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      let funds = await core.getConditionFunds(condIDHash);
      expect(funds[0]).to.be.equal(funds[1]);
      // after condition created, fund[0] and fund[1] are equal 1/2 of conditions reinforcement
      expect(funds[0]).to.be.equal((await core.getConditionReinforcement(condIDHash)).div(2));
    });
    it("Should view/return funds from canceled condition", async () => {
      time = await getBlockTime(ethers);
      condID++;

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      let tokenId = await getTokenId(
        await lp
          .connect(adr1)
          ["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, tokens(100), OUTCOMEWIN, time + 100, 0)
      );

      // check condition not passed yet
      await expect(lp.connect(adr1).withdrawPayout(tokenId)).to.be.revertedWith("ConditionNotStarted");

      // wait for ending condition
      await timeShift((await getBlockTime(ethers)) + ONE_HOUR);

      // try incorrect oracle wallet
      await expect(core.connect(maintainer).cancelByOracle(condID)).to.be.revertedWith("OnlyOracle");

      await core.connect(oracle).cancelByOracle(condID);

      // check payout
      expect((await lp.viewPayout(tokenId))[1]).to.be.equal(tokens(100));

      let BalBefore = await usdt.balanceOf(adr1.address);
      await lp.connect(adr1).withdrawPayout(tokenId);
      expect((await usdt.balanceOf(adr1.address)).sub(BalBefore)).to.be.equal(tokens(100));
    });
    it("Should view/return funds from canceled by maintainer condition", async () => {
      time = await getBlockTime(ethers);
      condID++;

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      let tokenId = await getTokenId(
        await lp
          .connect(adr1)
          ["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, tokens(100), OUTCOMEWIN, time + 100, 0)
      );

      // check condition not passed yet
      await expect(lp.connect(adr1).withdrawPayout(tokenId)).to.be.revertedWith("ConditionNotStarted");

      // wait for ending condition
      await timeShift((await getBlockTime(ethers)) + ONE_HOUR);

      // try incorrect oracle wallet

      let internalCondID = await core.oracleConditionIds(oracle.address, condID);
      await expect(core.connect(oracle).cancelByMaintainer(internalCondID)).to.be.revertedWith("OnlyMaintainer");

      await core.connect(maintainer).cancelByMaintainer(internalCondID);
      // try cancel again
      await expect(core.connect(maintainer).cancelByMaintainer(internalCondID)).to.be.revertedWith(
        "ConditionAlreadyResolved()"
      );

      // check payout
      expect((await lp.viewPayout(tokenId))[1]).to.be.equal(tokens(100));

      let BalBefore = await usdt.balanceOf(adr1.address);
      await lp.connect(adr1).withdrawPayout(tokenId);
      expect((await usdt.balanceOf(adr1.address)).sub(BalBefore)).to.be.equal(tokens(100));
    });
    it("Should shift condition time (end stake)", async () => {
      time = await getBlockTime(ethers);
      condID++;

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      // shift time to past, so condition is unavailable for staking
      await core.connect(maintainer).shift(condIDHash, time);

      await expect(
        lp
          .connect(adr1)
          ["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, tokens(100), OUTCOMEWIN, time + 100, 0)
      ).to.be.revertedWith("ConditionStarted");

      // shift time to future, so will be staking successful
      await core.connect(maintainer).shift(condIDHash, time + ONE_HOUR);

      let tokenId1 = await makeBetGetTokenId(lp, adr1, condIDHash, tokens(100), OUTCOMEWIN, time + 100, 0, lp.address);

      // bet payment
      await timeShiftBy(ethers, ONE_HOUR);
      await core.connect(oracle).resolveCondition(condID, OUTCOMEWIN);
      await lp.connect(adr1).withdrawPayout(tokenId1);
    });
    it("Create conditions by different oracles and get fee", async () => {
      await lp.claimDaoReward();
      time = await getBlockTime(ethers);
      condID++;

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      let condIDHash1 = await createCondition(
        core,
        oracle2,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      await lp["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, tokens(100), OUTCOMELOSE, time + 100, 0);

      await lp["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash1, tokens(100), OUTCOMELOSE, time + 100, 0);

      time = await getBlockTime(ethers);
      timeShift(time + ONE_HOUR);

      let oracleBal = await usdt.balanceOf(oracle.address);
      let oracleBal2 = await usdt.balanceOf(oracle2.address);

      await core.connect(oracle).resolveCondition(condID, OUTCOMEWIN);
      await core.connect(oracle2).resolveCondition(condID, OUTCOMEWIN);

      let oracleBalAfter = await usdt.balanceOf(oracle.address);
      let oracleBal2After = await usdt.balanceOf(oracle2.address);

      expect(oracleBalAfter.sub(oracleBal)).to.be.equal(tokens(1));
      expect(oracleBal2After.sub(oracleBal2)).to.be.equal(tokens(1));

      let ownerBal = await usdt.balanceOf(owner.address);
      await lp.claimDaoReward();
      let ownerBalAfter = await usdt.balanceOf(owner.address);
      expect(ownerBalAfter.sub(ownerBal)).to.be.equal(tokens(18)); // 9% of 200 tokens
    });
    it("Change fee %, create conditions by different oracles and get fee", async () => {
      lp.connect(owner).changeOracleReward(FEEHALFPERCENT); // set 0.5%
      lp.connect(owner).changeDaoReward(FEE5PERCENT); // set 5%

      time = await getBlockTime(ethers);
      condID++;

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      let condIDHash1 = await createCondition(
        core,
        oracle2,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      await lp["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash, tokens(100), OUTCOMELOSE, time + 100, 0);

      await lp["bet(uint256,uint128,uint64,uint64,uint64)"](condIDHash1, tokens(100), OUTCOMELOSE, time + 100, 0);

      time = await getBlockTime(ethers);
      timeShift(time + ONE_HOUR);

      let oracleBal = await usdt.balanceOf(oracle.address);
      let oracleBal2 = await usdt.balanceOf(oracle2.address);

      await core.connect(oracle).resolveCondition(condID, OUTCOMEWIN);
      await core.connect(oracle2).resolveCondition(condID, OUTCOMEWIN);

      let oracleBalAfter = await usdt.balanceOf(oracle.address);
      let oracleBal2After = await usdt.balanceOf(oracle2.address);

      expect(oracleBalAfter.sub(oracleBal)).to.be.equal(tokensDec(5, 17)); // 0.5
      expect(oracleBal2After.sub(oracleBal2)).to.be.equal(tokensDec(5, 17));

      let ownerBal = await usdt.balanceOf(owner.address);
      await lp.claimDaoReward();
      let ownerBalAfter = await usdt.balanceOf(owner.address);
      expect(ownerBalAfter.sub(ownerBal)).to.be.equal(tokens(10)); // 9% of 200 tokens

      // resolve bets
      //await lp.connect(owner).withdrawPayout(tokenId1);
    });
    it("Create CORE.condition/bet migrate to CORE2 make condition/bet and withdrawPayout", async () => {
      time = await getBlockTime(ethers);
      condID++;

      let condIDHash = await createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      let tokenId1 = await makeBetGetTokenId(lp, owner, condIDHash, tokens(100), OUTCOMEWIN, time + 100, 0);

      // setting up CORE2
      await core2.connect(owner).setLp(lp.address);
      await core2.connect(owner).setOracle(oracle.address);
      await core2.connect(owner).setOracle(maintainer.address);
      await core2.connect(owner).renounceOracle(maintainer.address);
      // all conditions must be resolved before switch core
      await expect(lp.changeCore(core2.address)).to.be.revertedWith("PaymentLocked");

      timeShift(time + ONE_HOUR);

      // resolve all unresolved conditions at CORE
      for (const i of conditionArr.keys()) {
        if (
          (await core.getCondition(conditionArr[i][2])).state == 0 &&
          (await core.getCondition(conditionArr[i][2])).timestamp != 0
        ) {
          await core.connect(conditionArr[i][0]).resolveCondition(conditionArr[i][1], OUTCOMEWIN);
        }
      }

      // get prize: token1 from CORE
      let balBefore = await usdt.balanceOf(owner.address);
      await lp.connect(owner).withdrawPayout(tokenId1);
      let balAfter = await usdt.balanceOf(owner.address);
      expect(balAfter).gt(balBefore);

      // change correct after all resolved CORE -> CORE2
      await lp.changeCore(core2.address);

      condID++;
      time = await getBlockTime(ethers);

      let condIDHash2 = await createCondition(
        core2,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      );

      time = await getBlockTime(ethers);
      let tokenId2 = await makeBetGetTokenId(lp, owner, condIDHash2, tokens(100), OUTCOMEWIN, time + 100, 0);

      let tokenId2Info = await core2.getBetInfo(tokenId2);
      expect(tokenId2Info.amount).to.be.equal(tokens(100));
      expect(tokenId2Info.createdAt).to.be.equal(time + 1);

      timeShift(time + ONE_HOUR);

      // resolve condition on CORE2
      await core2.connect(oracle).resolveCondition(condID, OUTCOMEWIN);

      // get prize: token2 from CORE2
      await lp.connect(owner).withdrawPayout(tokenId2);
      let balAfter2 = await usdt.balanceOf(owner.address);
      expect(balAfter2).gt(balAfter);

      // try burn NFT (it allowed only for LP)
      await expect(azurobet.burn(tokenId1)).to.be.revertedWith("OnlyLp");
    });
    it("Create incorrect CORE.condition params", async () => {
      time = await getBlockTime(ethers);
      await expect(
        createCondition(
          core2,
          oracle,
          condID,
          SCOPE_ID,
          [pool2, pool1],
          [OUTCOMEWIN, OUTCOMEWIN], // must be not equal
          time + ONE_HOUR,
          "ipfs"
        )
      ).to.be.revertedWith("SameOutcomes");

      await expect(
        createCondition(
          core2,
          oracle,
          condID,
          SCOPE_ID,
          [0, pool1], // no zeros
          [OUTCOMELOSE, OUTCOMEWIN],
          time + ONE_HOUR,
          "ipfs"
        )
      ).to.be.revertedWith("ZeroOdds");

      await expect(
        createCondition(
          core2,
          oracle,
          condID,
          SCOPE_ID,
          [pool2, 0], // no zeros
          [OUTCOMELOSE, OUTCOMEWIN],
          time + ONE_HOUR,
          "ipfs"
        )
      ).to.be.revertedWith("ZeroOdds");
    });
  });
  it("Create conditions, make bets, stop one/all/release conditions, make bets", async () => {
    time = await getBlockTime(ethers);

    let condIDs = [];
    let condIDHashes = [];

    for (const i of Array(5).keys()) {
      condID++;
      condIDs.push(condID);
    }

    // create 5 conditions
    for (const i of condIDs.keys()) {
      condIDHashes.push(
        await createCondition(
          core,
          oracle,
          condIDs[i],
          SCOPE_ID,
          [pool2, pool1],
          [OUTCOMEWIN, OUTCOMELOSE],
          time + ONE_HOUR,
          "ipfs"
        )
      );
    }

    // stop all conditions
    await core.connect(maintainer).stopAllConditions(true);

    // make one new condition
    condID++;
    condIDs.push(condID);

    condIDHashes.push(
      await createCondition(
        core,
        oracle,
        condIDs[condIDs.length - 1],
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      )
    );

    // try bet on any of conditions will be failed
    for (const i of condIDHashes.keys()) {
      await expect(
        makeBetGetTokenId(lp, owner, condIDHashes[i], tokens(100), OUTCOMEWIN, time + 100, 0)
      ).to.be.revertedWith("ConditionStopped");
    }

    // release all conditions
    await core.connect(maintainer).stopAllConditions(false);

    // stop only one condition (#0)
    await core.connect(maintainer).stopCondition(condIDHashes[0], true);

    // try bet all of conditions, all ok and only one will be failed (#0)
    let tokenIds = [];
    for (const i of condIDHashes.keys()) {
      if (i == 0) {
        await expect(
          makeBetGetTokenId(lp, owner, condIDHashes[i], tokens(100), OUTCOMEWIN, time + 100, 0)
        ).to.be.revertedWith("ConditionStopped");
      } else {
        tokenIds.push(await makeBetGetTokenId(lp, owner, condIDHashes[i], tokens(100), OUTCOMEWIN, time + 100, 0));
      }
    }

    // release condition (#0)
    await core.connect(maintainer).stopCondition(condIDHashes[0], false);

    // bet on release condition (#0) is ok
    tokenIds.push(await makeBetGetTokenId(lp, owner, condIDHashes[0], tokens(100), OUTCOMEWIN, time + 100, 0));

    // repay bets
    await timeShiftBy(ethers, ONE_HOUR);
    for (const i of condIDs.keys()) {
      await core.connect(oracle).resolveCondition(condIDs[i], OUTCOMEWIN);
    }

    for (const i of tokenIds.keys()) {
      await lp.withdrawPayout(tokenIds[i]);
    }
  });
  it("Try to make huge bet, that can't be payed out", async () => {
    time = await getBlockTime(ethers);
    condID++;

    let condIDHash = await createCondition(
      core,
      oracle,
      condID,
      SCOPE_ID,
      [pool2, pool1],
      [OUTCOMEWIN, OUTCOMELOSE],
      time + ONE_HOUR,
      "ipfs"
    );
    // try create same condition
    await expect(
      createCondition(
        core,
        oracle,
        condID,
        SCOPE_ID,
        [pool2, pool1],
        [OUTCOMEWIN, OUTCOMELOSE],
        time + ONE_HOUR,
        "ipfs"
      )
    ).to.be.revertedWith("ConditionAlreadyCreated()");

    await expect(
      makeBetGetTokenId(lp, adr1, condIDHash, tokens(7_000_000), OUTCOMEWIN, time + 100, 0)
    ).to.be.revertedWith("CantAcceptBet()");
  });
});
