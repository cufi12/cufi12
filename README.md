# Real-Debrid Manager

Private, mobile-friendly dashboard for one account. Uses the official Real-Debrid OAuth device flow.

## Features
- Device-code authorization (no Real-Debrid password or private API token entered into this app)
- Account and premium status
- List torrents and downloads
- Add a magnet link manually

## Deploy on Render
1. Create a Render Blueprint from this repository and review the plan.
2. The Blueprint generates a private `APP_PASSWORD` environment variable automatically.
3. Open the deployed service URL. The browser asks for HTTP Basic Auth:
   - Username: `manager`
   - Password: the generated `APP_PASSWORD` value from Render > Environment.
4. Select **Mit Real-Debrid verbinden**, then open the verification page and enter the displayed code.

## Security and limitations
- This is a personal, single-user starter, not a public multi-user service.
- OAuth credentials and tokens are kept in server memory only; a Render restart or redeploy requires authorizing again. Do not use this as a shared/public service.
- Keep the Render service private to yourself and do not share the generated app password.
- The app does not search third-party torrent indexes or provide copyrighted content. Only add files you are authorized to access.
- Never commit API tokens, OAuth secrets, or passwords to GitHub.

## Local run
```sh
npm install
APP_PASSWORD='choose-a-long-random-password' npm start
``
