# BookNest - free shared version

Static website (GitHub Pages) + free Supabase database.
Visitors can look around; members log in to book a seat; staff sign in with a password to make changes.

## First-time setup
1. Supabase: create a free project. Open SQL Editor > New query.
2. Open setup.sql, find the line  pw text := 'PUT-YOUR-PASSWORD-HERE';
   and type your staff password between the quotes (8+ characters, no apostrophe).
   Paste the whole file into the SQL Editor and press Run.
   Afterwards delete that query from the editor's saved list so the password isn't stored there.
3. Project Settings > API: copy the Project URL and the publishable (anon) key into config.js.
4. Upload all files to a public GitHub repository, then
   Settings > Pages > Deploy from branch (main, / root).
5. Open the site, tap "Staff login", enter your password.

## Upgrading from v4
Run the new setup.sql (with your password in it) and replace ALL website files
(there are 3 new ones: theme.js, member.js, admin.js), keeping your own config.js.
Books, seats and attendance are kept. Staff must log in once after upgrading.

## Members (new in v5)
- Tap **Member login** > Create account (full name, member/student ID, password).
- Logged-in members tap a free seat (or use their dashboard) to book it. It is held
  for 15 minutes; they scan the seat's QR code to confirm. One seat per member.
- After booking, the **Wi-Fi network and password** appear on their dashboard.
  Without a seat the Wi-Fi card stays locked. The password is only ever sent by the
  database to a member who currently holds a seat.
- **My dashboard**: current seat + countdown, Wi-Fi, visits, time studied, favourite
  seat, weekly chart and booking history.
- A seat left occupied for 12 hours is released automatically.

## Admin (staff only, new in v5)
- **Analytics**: seats in use, bookings per day, busiest hours, no-show rate, zone split,
  most-booked seats, most active members, books snapshot.
- **Members**: search, reset a password, switch an account off.
- **Wi-Fi**: set the network name and password members see. Update it whenever the router changes.

## Dark / light mode
The moon/sun button in the header switches theme. It follows the device setting until
a choice is made, then remembers it.

## Flat design
The whole UI uses solid colours and thin borders: no gradients, shadows, glows or blur. All of it lives in the last block of style.css ("FLAT DESIGN"); delete that block to get the softer look back.

## Trying it without Supabase
If config.js is not filled in, everything runs in memory with sample data (reset on
reload). Demo members: S1001 to S1009, password demo1234.

## Changing the staff password
Edit the password line in setup.sql and run it again. After 10 wrong
passwords in 10 minutes the login is locked for 10 minutes (re-running setup.sql unlocks it).

## What visitors can and can't do
- Can: view books, seats, notices; report a lost item; scan a seat QR code to confirm a held seat; create a member account.
- Can't: edit anything, or see Wi-Fi details without a booked seat.
- Names of borrowers, seat holders and attendance are visible to visitors.
- Seat QR codes are plain text, so they are a nudge to be present, not proof.
- Member passwords are stored hashed (bcrypt). Staff can reset but never read them.

## Notes
- Free Supabase projects pause after about a week of low use. Press "Resume project"; data is kept.
- The public key in config.js is meant to be visible. Never put the service_role / secret key there.
