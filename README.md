# Nebraska Card Table - Local Testing

This project is a small realtime two-player card table prototype using Node.js and Server-Sent Events.

## Prerequisites

- Node.js 18+ (or any modern Node.js runtime)

## Start the local server

1. From the project root, start the app:

   ```bash
   npm start
   ```

2. You should see output similar to:

   ```text
   Card table running on http://localhost:3000
   ```

3. Open your browser to:

   ```text
   http://localhost:3000
   ```

## Test multiplayer locally

To test two-player behavior on one machine:

1. Open the app in **two separate browser windows** (or one normal window + one incognito window).
2. Join with different display names in each window.
3. Verify realtime updates by:
   - Drawing cards in one window and confirming they appear in the other.
   - Moving a stack in one window and confirming position updates in the other.
   - Flipping a card and confirming face-up / face-down state syncs.

## Useful commands

- Syntax check server and client scripts:

  ```bash
  npm run check
  ```

## Notes

- Default port is `3000`.
- You can change the port when starting the server:

  ```bash
  PORT=4000 npm start
  ```
