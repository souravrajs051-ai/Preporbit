# PrepOrbit — deployable platform starter

A bright, responsive learning-platform website with a student account area, mentor application/login/dashboard, admin console, editable pricing/offers, monthly mentor tasks/payout records, SQLite persistence, and Razorpay order creation + server-side payment signature verification.

## Important: before publishing

This is a deployable full-stack application, not a static HTML mock-up. **Real payments will not work until you configure your own Razorpay merchant keys, domain, HTTPS, and production environment.** The package cannot create a public URL by itself. You must deploy it to a Node.js host and configure the payment provider.

The requested initial admin credentials are supplied only as environment-variable defaults in `.env.example`. They are public in the chat and must be changed before the website is exposed to the internet. Never commit your real `.env` file to GitHub.

## Requirements

- Node.js 20 or newer
- A host that supports a persistent disk/volume for SQLite and sessions
- HTTPS for production sessions and payment checkout
- Your own verified Razorpay account and keys for the appropriate test/live mode

## Local setup

1. Copy `.env.example` to `.env`.
2. Change `SESSION_SECRET` to a long random value and change both admin credentials.
3. Set `SITE_URL` to your intended HTTPS domain.
4. Install dependencies: `npm install`
5. Start: `npm start`
6. Open `http://localhost:3000`.

The database is created automatically at the path configured by `DATABASE_PATH`.

## Payment setup

1. Create/verify your merchant account with Razorpay and complete its KYC/onboarding requirements.
2. Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to the host's private environment settings (not frontend code).
3. Test in Razorpay test mode before accepting real payments.
4. Configure a Razorpay webhook pointing to `https://YOUR_DOMAIN/api/payments/webhook`, with the same secret in `RAZORPAY_WEBHOOK_SECRET`. Subscribe to `payment.captured` and `payment.failed`.
5. After successful end-to-end tests and merchant approval, set live keys in the host's environment. Never paste secret keys into the website or public repository.

Checkout orders are created on the server, and the browser payment signature is verified server-side. Webhook signatures are also verified. Use the provider's dashboard to reconcile actual settlements and refunds; this application does not itself transfer funds or automatically refund payments.

## Admin and mentor features

- Admin overview, verified revenue, recent purchases and students
- Edit plan title, original price, offer price, description and visibility
- Create/activate/deactivate offers
- Review/activate/pause mentor accounts; create mentor accounts
- Assign monthly tasks and track completion
- Record mentor payout amounts/status (records only; transfers are manual)
- Audit log and password change
- Mentors can review their monthly task dashboard, mark tasks completed and see recorded payouts
- Students can create accounts, pay for plans when the gateway is configured, and view purchase history

## Before accepting students' money

Publish accurate terms of service, privacy policy, refund/cancellation policy, support email/contact, actual service inclusions, mentor verification criteria and realistic delivery timelines. Do not advertise tests, mentorship sessions, response times or results unless you can actually deliver them. If serving minors, obtain appropriate parent/guardian consent and minimise the student data you collect.

## Notes / limits

- Passwords are hashed; sessions use HTTP-only cookies and server-side session storage.
- Use a persistent disk: ephemeral hosting can lose SQLite data.
- Configure backups, monitoring, email delivery, CSRF protection strategy, privacy/legal pages and production review before scaling. This package is a strong launch foundation, but it is not a substitute for security review or legal/accounting advice.
- Admin username is treated as the account email internally; it can be typed into the login field as the username string.
