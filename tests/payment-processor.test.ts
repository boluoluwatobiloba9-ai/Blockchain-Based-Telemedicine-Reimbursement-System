import { describe, it, expect, beforeEach, vi } from "vitest";
import { Cl, ClarityValue, stringUtf8CV, uintCV, principalCV, bufferCV, tupleCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_AMOUNT = 101;
const ERR_INSUFFICIENT_FUNDS = 102;
const ERR_ALREADY_PAID = 104;
const ERR_INVALID_SESSION_HASH = 105;
const ERR_AUTHORITY_NOT_VERIFIED = 109;

interface Payment {
  sessionId: number;
  provider: string;
  patient: string;
  amount: number;
  timestamp: number;
  status: string;
  funder: string;
  sessionHash: Buffer;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class PaymentProcessorMock {
  state: {
    authorityContract: string | null;
    maxPaymentAmount: number;
    minPaymentAmount: number;
    paymentFee: number;
    payments: Map<number, Payment>;
    paymentStatus: Map<number, boolean>;
    fundBalances: Map<string, number>;
    nextPaymentId: number;
  } = {
    authorityContract: null,
    maxPaymentAmount: 1000000,
    minPaymentAmount: 100,
    paymentFee: 500,
    payments: new Map(),
    paymentStatus: new Map(),
    fundBalances: new Map(),
    nextPaymentId: 0,
  };
  blockHeight: number = 0;
  caller: string = "ST1TEST";
  stxTransfers: Array<{ amount: number; from: string; to: string }> = [];
  serviceRegistry = { verifyService: vi.fn().mockReturnValue({ ok: true, value: true }) };
  patientVerifier = { isVerified: vi.fn().mockReturnValue({ ok: true, value: true }) };

  reset() {
    this.state = {
      authorityContract: null,
      maxPaymentAmount: 1000000,
      minPaymentAmount: 100,
      paymentFee: 500,
      payments: new Map(),
      paymentStatus: new Map(),
      fundBalances: new Map(),
      nextPaymentId: 0,
    };
    this.blockHeight = 0;
    this.caller = "ST1TEST";
    this.stxTransfers = [];
    this.serviceRegistry.verifyService.mockReturnValue({ ok: true, value: true });
    this.patientVerifier.isVerified.mockReturnValue({ ok: true, value: true });
  }

  setAuthorityContract(contractPrincipal: string): Result<boolean> {
    if (contractPrincipal === "SP000000000000000000002Q6VF78") return { ok: false, value: false };
    if (this.state.authorityContract !== null) return { ok: false, value: false };
    this.state.authorityContract = contractPrincipal;
    return { ok: true, value: true };
  }

  setPaymentFee(newFee: number): Result<boolean> {
    if (!this.state.authorityContract) return { ok: false, value: false };
    this.state.paymentFee = newFee;
    return { ok: true, value: true };
  }

  processPayment(
    sessionId: number,
    provider: string,
    patient: string,
    amount: number,
    sessionHash: Buffer,
    funder: string
  ): Result<number> {
    if (!this.state.authorityContract) return { ok: false, value: ERR_AUTHORITY_NOT_VERIFIED };
    if (amount < this.state.minPaymentAmount || amount > this.state.maxPaymentAmount) return { ok: false, value: ERR_INVALID_AMOUNT };
    if (sessionHash.length === 0) return { ok: false, value: ERR_INVALID_SESSION_HASH };
    const currentBalance = this.state.fundBalances.get(funder) || 0;
    if (currentBalance < (amount + this.state.paymentFee)) return { ok: false, value: ERR_INSUFFICIENT_FUNDS };
    if (this.state.paymentStatus.get(this.state.nextPaymentId)) return { ok: false, value: ERR_ALREADY_PAID };
    if (!this.serviceRegistry.verifyService(sessionId, patient, sessionHash).value) return { ok: false, value: ERR_INVALID_SESSION_HASH };
    if (!this.patientVerifier.isVerified(sessionId, patient).value) return { ok: false, value: ERR_INVALID_SESSION_HASH };

    this.stxTransfers.push({ amount, from: this.caller, to: provider });
    this.stxTransfers.push({ amount: this.state.paymentFee, from: this.caller, to: this.state.authorityContract! });
    const paymentId = this.state.nextPaymentId;
    this.state.payments.set(paymentId, { sessionId, provider, patient, amount, timestamp: this.blockHeight, status: "completed", funder, sessionHash });
    this.state.paymentStatus.set(paymentId, true);
    this.state.fundBalances.set(funder, currentBalance - (amount + this.state.paymentFee));
    this.state.nextPaymentId++;
    return { ok: true, value: paymentId };
  }

  getPayment(paymentId: number): Payment | null {
    return this.state.payments.get(paymentId) || null;
  }

  getFundBalance(funder: string): number {
    return this.state.fundBalances.get(funder) || 0;
  }

  updateFundBalance(funder: string, amount: number): Result<boolean> {
    if (!this.state.authorityContract) return { ok: false, value: false };
    if (amount <= 0) return { ok: false, value: false };
    const current = this.getFundBalance(funder);
    this.state.fundBalances.set(funder, current + amount);
    return { ok: true, value: true };
  }
}

describe("PaymentProcessor", () => {
  let contract: PaymentProcessorMock;

  beforeEach(() => {
    contract = new PaymentProcessorMock();
    contract.reset();
  });

  it("processes payment successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.updateFundBalance("ST3FUNDER", 2000);
    const sessionHash = Buffer.from("a".repeat(32));
    const result = contract.processPayment(1, "ST4PROVIDER", "ST5PATIENT", 1000, sessionHash, "ST3FUNDER");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
    const payment = contract.getPayment(0);
    expect(payment).toEqual({
      sessionId: 1,
      provider: "ST4PROVIDER",
      patient: "ST5PATIENT",
      amount: 1000,
      timestamp: 0,
      status: "completed",
      funder: "ST3FUNDER",
      sessionHash
    });
    expect(contract.stxTransfers).toEqual([
      { amount: 1000, from: "ST1TEST", to: "ST4PROVIDER" },
      { amount: 500, from: "ST1TEST", to: "ST2TEST" }
    ]);
    expect(contract.getFundBalance("ST3FUNDER")).toBe(500);
  });

  it("rejects payment without authority contract", () => {
    const sessionHash = Buffer.from("a".repeat(32));
    const result = contract.processPayment(1, "ST4PROVIDER", "ST5PATIENT", 1000, sessionHash, "ST3FUNDER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_AUTHORITY_NOT_VERIFIED);
  });

  it("rejects payment with insufficient funds", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.updateFundBalance("ST3FUNDER", 100);
    const sessionHash = Buffer.from("a".repeat(32));
    const result = contract.processPayment(1, "ST4PROVIDER", "ST5PATIENT", 1000, sessionHash, "ST3FUNDER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INSUFFICIENT_FUNDS);
  });

  it("rejects payment with invalid amount", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.updateFundBalance("ST3FUNDER", 2000);
    const sessionHash = Buffer.from("a".repeat(32));
    const result = contract.processPayment(1, "ST4PROVIDER", "ST5PATIENT", 50, sessionHash, "ST3FUNDER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_AMOUNT);
  });

  it("rejects payment with invalid session hash", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.updateFundBalance("ST3FUNDER", 2000);
    const sessionHash = Buffer.from("");
    const result = contract.processPayment(1, "ST4PROVIDER", "ST5PATIENT", 1000, sessionHash, "ST3FUNDER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_SESSION_HASH);
  });

  it("sets payment fee successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.setPaymentFee(1000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.paymentFee).toBe(1000);
  });
});