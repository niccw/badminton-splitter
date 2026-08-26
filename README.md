# Badminton Splitter

A small shared web app for tracking badminton sessions: who booked and paid
for the court, who's joining, and the minimum number of bank transfers
needed to settle everyone up afterwards.

Everyone signs in with their Google account. That's the gate that keeps
the group's data away from random strangers on the internet, and it also
means each person can only ever join a session as themselves and only
mark their own payments as settled — nobody can (even accidentally) edit
someone else's row. Data is shared live across everyone using the app
(via a free Firebase database), and the app itself is hosted for free on
GitHub Pages.

## How the cost-splitting works

1. When a session is created, you record who fronted the court booking
   cost and how much each of them paid (usually one or two people).
2. As people join the session, the total court cost is split evenly
   across everyone who joined.
3. Hit **Calculate transfers** to get the minimum set of payments needed
   to settle up — e.g. with 2 payers and 10 players, it might work out
   as most people paying person A directly and one or two paying person
   B, rather than everyone owing a bit to both.

The algorithm (in `splitLogic.js`) computes each person's net balance
(what they paid minus their fair share) and then greedily matches the
largest debts against the largest credits until everyone nets to zero.
This is the standard approach used by bill-splitting apps and gives the
minimal (or very close to minimal) number of transfers in practice.
There's a small test suite for it in `tests/splitLogic.test.js` — run it
with `node tests/splitLogic.test.js`.

## One-time setup

You'll do three things: create a free Firebase project (this is where
the shared data lives), turn on Google sign-in for it, and put this code
on GitHub Pages (this is what serves the actual website). Takes about
15–20 minutes.

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
   and sign in with a Google account.
2. Click **Add project**, give it any name (e.g. "badminton-splitter"),
   and finish the wizard (you can decline Google Analytics — not needed).
3. In the left sidebar, go to **Build → Firestore Database**, click
   **Create database**, choose a location close to you, and start in
   **production mode**.
4. Once created, go to the **Rules** tab of Firestore and paste in the
   contents of `firestore.rules` from this project, then click **Publish**.
   (These rules require sign-in and restrict everyone to editing only
   their own data — see the comment at the top of that file for details.)
5. Go to **Project settings** (gear icon, top left) → scroll to
   **Your apps** → click the **</>** (web) icon to register a new web app
   (any nickname is fine; leave "Also set up Firebase Hosting" unchecked
   — we're using GitHub Pages instead).
6. Firebase will show you a `firebaseConfig` object. Copy the values into
   `firebase-config.js` in this project, replacing the `REPLACE_ME`
   placeholders. This file is safe to commit — it's not a secret, it's a
   public client identifier (your data is protected by the Rules from
   step 4 and by requiring sign-in, not by hiding this file).

### 2. Turn on Google sign-in

1. In the left sidebar, go to **Build → Authentication**, click
   **Get started**.
2. Under **Sign-in method**, click **Google** in the provider list,
   toggle it **Enable**, pick a support email (any email tied to your
   Google account), and **Save**.
3. Still in Authentication, go to the **Settings** tab → **Authorized
   domains**, and click **Add domain**. Add your future GitHub Pages
   domain here — it'll be `<your-username>.github.io` (just the domain,
   no `https://` or path). You can add this now even before Pages is
   live; if you don't know your final URL yet, come back to this step
   after step 3 below.

### 3. Put the code on GitHub Pages

1. Create a new **public** repository on GitHub (Pages' free tier needs
   the repo to be public unless you're on a paid GitHub plan).
2. Push all the files in this folder to that repository, e.g.:
   ```bash
   cd badminton-splitter
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
3. On GitHub, go to the repo's **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a
   branch**, set branch to **main** and folder to **/(root)**, then save.
5. GitHub will give you a URL like
   `https://<your-username>.github.io/<your-repo>/` — it can take a
   minute or two to go live the first time. Make sure `<your-username>.github.io`
   is in the Authorized domains list from step 2.3 above, or sign-in will
   fail with an "unauthorized domain" error.

That's it — share that URL with your badminton group. The first time
each person opens it, they'll sign in with Google and pick their name.

## Using the app

- **Sign in**: everyone signs in with Google first. The very first time,
  you'll be asked what name the group should see you as — if you were
  already added as someone who paid for a booking (see below), type the
  same name to link up with that record instead of creating a duplicate.
  You can also set how you'd like to be paid back here (a payment
  link/handle, or leave it blank for now — editable any time from the
  header).
- **New session**: record the date, venue, total court cost, and who
  paid for the booking (and how much each of them paid). You can name
  anyone here, whether or not they've signed in yet — this is the
  organiser recording a fact, not a claim that person has to make
  themselves.
- **Join session**: click **Join as \<your name\>** — you can only ever
  join as yourself, using the identity from your Google sign-in.
- **Settle up**: only an admin sees a **Calculate transfers** button —
  ideally clicked once the session's actually happened, so who did and
  didn't show up is settled. Once they hit it, everyone sees exactly
  who should pay whom, and how much, along with each recipient's saved
  payment info; regular members just see "not calculated yet" until
  then. An admin can **Reset** it to hide the result again (e.g. if
  someone still needs to join). Everyone can tick **paid** on their own
  row once they've sent their transfer; you'll only see a checkbox on
  your own row — everyone else's shows as plain "paid" / "not paid yet"
  text, since only they can change their own status (unless you're an
  admin — see below).
- **Withdraw / cancel / edit**: if you joined a session but can't make
  it, **Withdraw** from your own row. Whoever created a session can
  **Edit** its details (date, venue, cost, who paid what) or **Cancel**
  it — cancelling just marks it cancelled and keeps it on record; it
  can be reopened.

### Admins

There's an optional admin role for group organisers who need to fix
things on other people's behalf — e.g. marking someone paid after
they Venmo'd you in person, or removing a no-show who said they were
in but never actually joined. Admins can tick **paid** and remove
participants for *anyone*, not just themselves, and are the only ones
who can calculate (or reset) a session's settle-up result.

There's no in-app way to become an admin or grant it to someone else —
it's entirely managed by hand in the Firebase console, on purpose,
so it can't be self-escalated from the app:

1. Find the person's uid — either the **Authentication** tab's user
   list, or the `uid` field on their `players` doc in **Firestore
   Data**.
2. In **Firestore Data**, create a collection named `admins` (if it
   doesn't exist yet) and add a document whose **document ID** is that
   uid, with a single field `isAdmin` (boolean) set to `true`.
3. They'll see an "admin" badge next to their name next time the app
   syncs (usually instantly, no reload needed). To revoke, flip
   `isAdmin` to `false` or delete the document.

## A couple of things worth knowing

- Payment details are stored as free text exactly as typed (e.g. a
  payment link, a handle, or "cash only") — nothing is validated or
  processed; the app never moves money itself, it just tells people what
  to send and to whom.
- Being signed in with Google doesn't give anyone extra power over
  other people's data — the Firestore rules restrict every write to
  "your own player profile" and "your own row in a session," regardless
  of who's asking, with two exceptions: creating a session and
  recording who paid for the booking is unrestricted (that's usually
  the organiser noting a fact on someone else's behalf), and admins
  (console-managed only, see above) can mark anyone paid or remove
  anyone from a session.
- The Firebase free tier comfortably covers a group this size (tens of
  thousands of reads/writes per day, 1GB storage) and doesn't expire or
  pause itself from inactivity. Google sign-in is also free with no
  meaningful usage limit for a group this size.

## Project files

```
index.html          Page structure & templates
style.css            Styling (light/dark mode aware)
app.js               App logic: auth, routing, Firestore reads/writes, rendering
splitLogic.js        Pure cost-splitting / settle-up algorithm (also used by tests)
firebase-config.js   Your Firebase project's public client config (fill this in)
firestore.rules      Firestore security rules (sign-in required, per-person ownership)
tests/               Node + Playwright test suite (not needed to run the app itself)
```
