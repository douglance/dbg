import { describe, expect, it } from "vitest";
import { parseFlowAction } from "../packages/cli/src/flow-model.js";

describe("Plan Y flow action parser", () => {
	it("parses valid binding payloads", () => {
		const action = parseFlowAction(
			JSON.stringify({
				kind: "input",
				selector: "#name",
				fallbackPath: "body > form:nth-of-type(1) > input:nth-of-type(1)",
				value: "hello",
			}),
		);

		expect(action).toEqual({
			kind: "input",
			selector: "#name",
			fallbackPath: "body > form:nth-of-type(1) > input:nth-of-type(1)",
			value: "hello",
		});
	});

	it("accepts selectorless nav and scroll actions", () => {
		expect(
			parseFlowAction('{"kind":"nav","value":"https://example.test/"}'),
		).toEqual({
			kind: "nav",
			selector: null,
			fallbackPath: null,
			value: "https://example.test/",
		});
		expect(parseFlowAction('{"kind":"scroll","value":"120"}')).toEqual({
			kind: "scroll",
			selector: null,
			fallbackPath: null,
			value: "120",
		});
	});

	it("rejects malformed json and unknown action kinds", () => {
		expect(parseFlowAction("{")).toBeNull();
		expect(parseFlowAction('{"kind":"hover","selector":"button"}')).toBeNull();
		expect(parseFlowAction('{"selector":"#name"}')).toBeNull();
	});
});
