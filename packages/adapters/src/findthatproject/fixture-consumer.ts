import {
  isFindThatProjectDiscoveryV1,
  type FindThatProjectDiscoveryV1,
} from "@hn-knowledge/contracts";

export class FindThatProjectContractError extends Error {
  constructor(readonly code: "CONTRACT_NOT_APPROVED" | "PAYLOAD_INVALID") {
    super(code);
    this.name = "FindThatProjectContractError";
  }
}

export class FixtureFindThatProjectConsumer {
  readonly mutatingRequests = 0;

  constructor(private readonly contractApproved: boolean) {}

  validate(payload: unknown): FindThatProjectDiscoveryV1 {
    if (!this.contractApproved) {
      throw new FindThatProjectContractError("CONTRACT_NOT_APPROVED");
    }
    if (!isFindThatProjectDiscoveryV1(payload)) {
      throw new FindThatProjectContractError("PAYLOAD_INVALID");
    }
    return payload;
  }
}
