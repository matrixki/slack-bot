const request = require("supertest");
const { receiver } = require("../index");
const db = require("../db");

// ✅ Mock the `db.query` function
jest.mock("../db", () => ({
    query: jest.fn(),
}));

describe("GET /api/conversations", () => {
    afterEach(() => {
        jest.clearAllMocks(); // ✅ Reset mocks after each test
    });

    it("should return user conversations", async () => {
        // ✅ Mock database return value
        db.query.mockResolvedValue([
            [
                { user_message: "Hello", bot_response: "Hi there!", source: "dashboard", timestamp: "2024-03-14 10:00:00" },
                { user_message: "What's the weather?", bot_response: "It's sunny!", source: "dashboard", timestamp: "2024-03-14 10:05:00" }
            ]
        ]);

        const response = await request(receiver.app)
            .get("/api/conversations")
            .query({ userId: "U12345" });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("conversations");
        expect(response.body.conversations.length).toBe(2);
        expect(response.body.conversations[0].user_message).toBe("Hello");
    });

    it("should return a 400 error if userId is missing", async () => {
        const response = await request(receiver.app).get("/api/conversations");
        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty("error", "User ID is required.");
    });

    it("should return a 500 error if database query fails", async () => {
        db.query.mockRejectedValue(new Error("Database error"));

        const response = await request(receiver.app)
            .get("/api/conversations")
            .query({ userId: "U12345" });

        expect(response.status).toBe(500);
        expect(response.body).toHaveProperty("error", "Failed to fetch conversations.");
    });
});
