import { describe, expect, it } from "vitest";

import { expandedCommandPrompt } from "./support/events.js";

import { expandedAction, isFlightpathCommand } from "../src/commands.js";

describe("reading a command from its expanded form", () => {
  it("gives the action of the two-line prompt", () => {
    expect(expandedAction(expandedCommandPrompt("flightpath:open"))).toBe(
      "open",
    );
    expect(expandedAction(expandedCommandPrompt("flightpath:start"))).toBe(
      "start",
    );
  });

  it("gives nothing for a command that is not Flightpath's", () => {
    expect(expandedAction(expandedCommandPrompt("review"))).toBeNull();
  });

  it("gives nothing for a plain prompt", () => {
    expect(expandedAction("/flightpath:open")).toBeNull();
    expect(expandedAction("please open the live view")).toBeNull();
  });

  it("ignores arguments after the command name", () => {
    const prompt = `${expandedCommandPrompt("flightpath:status")}\n<command-args>dance</command-args>`;
    expect(expandedAction(prompt)).toBe("status");
  });
});

describe("telling a Flightpath command from any other text", () => {
  it("counts the expanded form of each of the six commands", () => {
    for (const action of ["status", "stop", "start", "off", "forget", "open"]) {
      expect(
        isFlightpathCommand(expandedCommandPrompt(`flightpath:${action}`)),
        action,
      ).toBe(true);
    }
  });

  it("still counts the plain command, with or without arguments", () => {
    expect(isFlightpathCommand("/flightpath:open")).toBe(true);
    expect(isFlightpathCommand("flightpath:status")).toBe(true);
    expect(isFlightpathCommand("/flightpath:stop for now")).toBe(true);
  });

  it("does not count another command in the expanded form", () => {
    expect(isFlightpathCommand(expandedCommandPrompt("review"))).toBe(false);
    expect(isFlightpathCommand(expandedCommandPrompt("flightpath:nope"))).toBe(
      false,
    );
  });

  it("does not count a prompt that only mentions a command", () => {
    expect(isFlightpathCommand("run /flightpath:open for me")).toBe(false);
  });
});
