import { orderByChain } from "../../src/modules/queue/status-chain.ts";

const change = (fromStatus: string, toStatus: string) => ({ fromStatus, toStatus });

describe("a status timeline ordered by its own chain", () => {
  test("one transaction's changes, given in any order, come back in the order they happened", () => {
    const waiting = change("WAITING", "IN_CONSULTATION");
    const completed = change("IN_CONSULTATION", "COMPLETED");
    expect(orderByChain([completed, waiting])).toEqual([waiting, completed]);
    expect(orderByChain([waiting, completed])).toEqual([waiting, completed]);
  });

  test("a longer chain shuffled is still put back", () => {
    const links = [change("BOOKED", "ARRIVED"), change("ARRIVED", "WAITING"), change("WAITING", "IN_CONSULTATION"), change("IN_CONSULTATION", "COMPLETED")];
    expect(orderByChain([links[2]!, links[0]!, links[3]!, links[1]!])).toEqual(links);
  });

  test("one change or none needs no chain", () => {
    expect(orderByChain([])).toEqual([]);
    const only = change("BOOKED", "ARRIVED");
    expect(orderByChain([only])).toEqual([only]);
  });

  test("changes that do not form exactly one chain are refused, not guessed", () => {
    expect(orderByChain([change("WAITING", "PAUSED"), change("PAUSED", "WAITING")])).toBeNull();
    expect(orderByChain([change("BOOKED", "ARRIVED"), change("WAITING", "COMPLETED")])).toBeNull();
  });
});
