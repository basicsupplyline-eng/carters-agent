# Carters Order Agent — Deployment Guide

This runs 24/7 in the cloud. Customer texts you → Claude parses the order →
Carters gets an email → they confirm an ETA on a simple web page → customer
gets a text with the ETA.

## What you need first

- [ ] Twilio account with a number (WhatsApp sandbox or SMS number)
- [ ] Anthropic API key from console.anthropic.com
- [ ] A Gmail account to send emails to Carters from (with an "app password" — see below)
- [ ] Carters contact's email address
- [ ] A GitHub account (free) — Render deploys from GitHub

## Step 1 — Get a Gmail app password

1. Go to myaccount.google.com/security
2. Turn on 2-Step Verification if it isn't already on
3. Search "App Passwords", create one named "Carters Agent"
4. Copy the 16-character password — this goes in `SMTP_PASS`, not your normal Gmail password

## Step 2 — Put this code on GitHub

1. Go to github.com, create a new repository called `carters-agent`
2. Upload all the files in this folder (server.js, package.json, .env.example, README.md) using the "upload files" button on the repo page — no command line needed
3. Do NOT upload a real `.env` file with actual secrets in it — those go into Render directly (next step)

## Step 3 — Deploy on Render

1. Go to render.com, sign up, click "New +" → "Web Service"
2. Connect your GitHub account, select the `carters-agent` repo
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
4. Under "Environment", add every variable from `.env.example` with your real values
5. Click "Create Web Service" — Render will build and deploy it, and give you a URL like `https://carters-agent.onrender.com`
6. Go back into Render's environment variables and set `PUBLIC_URL` to that exact URL

## Step 4 — Point Twilio at your new URL

1. In the Twilio console, go to your phone number's settings
2. Find "A message comes in" (under Messaging or WhatsApp Sandbox settings)
3. Set the webhook URL to: `https://carters-agent.onrender.com/webhook/incoming`
4. Method: HTTP POST
5. Save

## Step 5 — Test it

1. Text your Twilio number something like: "Need 20 bags of GIB Fix All and a pallet of H3.2 timber, deliver to Wadestown Road site, fairly urgent"
2. You should get an auto-reply confirming receipt with a reference number
3. Check the Carters inbox — they should have an email with the order and a link
4. Open that link, enter the ETA and the admin password, submit
5. The original texter gets a confirmation text with the ETA

## Notes

- Free Render tier "sleeps" after inactivity and takes ~30 seconds to wake on the first message after a quiet period. Fine for testing; if this becomes daily-use, upgrade to Render's paid tier (~$7/month) so it's instantly live.
- Orders are stored in a file called `orders.json` on the server. This is fine to start but isn't a proper database — if you want order history that survives redeploys, we can switch this to a real database later (e.g. Postgres, which Render also hosts).
- The admin confirmation page is protected by a single shared password. If more than one person at Carters will use it, we should build proper logins — happy to add that once the basic flow is working.
