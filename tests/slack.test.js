const { slackApp } = require("../index");

describe("Slack Bot Tests", () => {
    beforeAll(() => {
        process.env.NODE_ENV = "test"; // ✅ Prevent bot from running
    });

    it("should initialize Slack bot", async () => {
        expect(slackApp).toBeDefined();
    });
});
