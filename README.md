# BookNest - free shared version

Static website (GitHub Pages) + free Supabase database.
Visitors can look around; staff sign in with a password to make changes.

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

## Upgrading from an earlier version
Run the new setup.sql (with your password in it) and replace the website files,
keeping your own config.js. Books, seats and attendance are kept. Any member
records saved by the previous version are deleted by setup.sql.

## Changing the staff password
Edit the password line in setup.sql and run it again. After 10 wrong
passwords in 10 minutes the login is locked for 10 minutes (re-running setup.sql unlocks it).

## What visitors can and can't do
- Can: view books, seats, notices; report a lost item; scan a seat QR code to confirm a held seat.
- Can't: edit anything.
- Names of borrowers, seat holders and attendance are visible to visitors.

## Notes
- Free Supabase projects pause after about a week of low use. Press "Resume project"; data is kept.
- The public key in config.js is meant to be visible. Never put the service_role / secret key there.
