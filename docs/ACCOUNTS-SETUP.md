# Accounts — Microsoft sign-in and cloud projects

Turns the sign-in page from a name label into real authentication, and moves
projects out of the browser and into an account that follows you between
devices.

Nothing here needs the Render backend. The browser talks to Supabase directly.

**Until step 3 is done the app still works** — it falls back to a local
profile and keeps projects in the browser, and the sign-in page says so.

---

## What protects the data

Worth being clear about, because it is not the JavaScript.

The browser holds a **publishable key** (`SUPABASE_ANON_KEY`). Anyone can read
it — it is in the page source, exactly like the Google Maps key. It grants
nothing on its own.

What decides who can read which row is **Row Level Security**: policies stored
in Postgres, evaluated on every row of every query, against the user id proven
by a signed token. A modified client asking for `select * from projects` gets
back only its own rows, because the database refuses the rest.

This is why step 2 is not optional. **A table without policies is readable by
every anonymous visitor on the internet.** Create the tables and the policies
together, before real work goes in.

Never put the `service_role` key in the client. That one bypasses RLS by
design and belongs only in server environment variables.

---

## 1. Get the anon key

Supabase → your project → **Project Settings → API Keys** → copy the
`anon` / `public` value (a long `eyJ…` string).

Paste it into `js/config.js`:

```js
const SUPABASE_ANON_KEY = 'eyJhbGciOi…';
```

`SUPABASE_URL` is already filled in. Nothing else changes.

## 2. Create the tables and policies

Supabase → **SQL Editor → New query** → paste the entire contents of
`sql/supabase-auth.sql` → **Run**.

Paste the file's *contents*, not its name.

It creates `profiles` and `projects`, enables RLS on both, adds the four
per-operation policies, and installs a trigger that fills in a profile when
someone signs up.

**Then verify it, because "Success. No rows returned" does not mean protected.**
That message appears both when statements ran fine and when a `SELECT`
matched nothing. Run this on its own:

```sql
select tablename,
       rowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = t.tablename) as policies
  from pg_tables t
 where schemaname = 'public' and tablename in ('profiles', 'map_projects');
```

Expect two rows, both `rls_enabled = true`, with `map_projects` showing 4 policies
and `profiles` showing 2. Anything else means the script did not finish — read
the error rather than moving on.

## 3. Microsoft sign-in

Two registrations that have to agree: one in Azure, one in Supabase.

### 3a. Azure — register the application

**Entra admin centre** (`entra.microsoft.com`) → **Applications → App
registrations → New registration**.

| Field | Value |
|---|---|
| Name | `DBOT Map Studio` |
| Supported account types | **Accounts in this organizational directory only** — single tenant |
| Redirect URI | **Web** → `https://sacyafztfticssuzkrze.supabase.co/auth/v1/callback` |

Single tenant is what actually restricts sign-in to dbotrealty.com. It rejects
other organisations at Microsoft, before Supabase is ever reached — a far
stronger gate than the email check in the app, which is only there to give a
clear message.

The redirect URI is **Supabase's**, not your site's. Microsoft returns to
Supabase, which then returns to your page. Getting this wrong produces
`AADSTS50011: redirect URI does not match`, which is the most common failure
here.

Then, on the new registration:

1. **Certificates & secrets → New client secret.** Copy the **Value**
   immediately — it is shown once and cannot be retrieved later. Note the
   expiry; sign-in breaks on that date and the symptom will not mention it.
2. **API permissions** → confirm `openid`, `profile`, `email`,
   `offline_access` under Microsoft Graph. Add any that are missing, then
   **Grant admin consent** so nobody is prompted individually.
3. **Overview** → copy the **Application (client) ID** and the
   **Directory (tenant) ID**.

### 3b. Supabase — enable the provider

**Authentication → Providers → Azure** → enable, then:

| Field | Value |
|---|---|
| Client ID | Application (client) ID |
| Secret | the secret **Value** from 3a |
| Azure Tenant URL | `https://login.microsoftonline.com/<your-tenant-id>` |

Then **Authentication → URL Configuration**:

- **Site URL** — where people land after signing in, e.g.
  `https://adityabachal85.github.io/Map-studio/projects.html`
- **Redirect URLs** — add every origin the app is served from. Local
  development needs its own entry; a URL that is not listed is rejected:
  ```
  https://adityabachal85.github.io/Map-studio/**
  http://localhost:8000/**
  ```

## 4. Add someone who signs in with a password

Most people should use the Microsoft button. For an account that does not go
through Entra:

**Authentication → Users → Add user → Create new user.** Enter the email and
password, and tick **Auto Confirm User** — otherwise they cannot sign in until
they click a confirmation link.

The domain trigger from step 2 rejects any address outside dbotrealty.com,
here as well as through the app.

To stop anyone creating their own account: **Authentication → Sign In / Providers**
→ turn **Allow new users to sign up** off. Then accounts exist only when you
add them.

## 5. Check it works

1. Open `login.html`. It should show **Continue with Microsoft** — if it still
   shows a name field, `SUPABASE_ANON_KEY` has not been picked up. Hard-refresh;
   the `?v=` on the script tag means a stale cache is unlikely but not
   impossible.
2. Sign in. You should return to `projects.html` with your name in the corner.
3. The source toggle should show **Cloud** selected, not "This device".
4. Create a project, then open the same URL in a different browser and sign in
   again. The project should be there. That round trip is the real proof —
   anything less could be served from local storage.
5. Supabase → **Table Editor → map_projects**: one row, `owner_id` matching your
   user in **Authentication → Users**.

Projects already on the machine are copied into the account the first time you
sign in, and you are told how many. They are **copied, not moved** — if the
upload half-fails or you signed in to the wrong account, the originals are
untouched.

---

## When it does not work

| Symptom | Cause |
|---|---|
| Sign-in page still asks for a name | `SUPABASE_ANON_KEY` is empty in `js/config.js` |
| "Could not reach the sign-in service" | `SUPABASE_URL` wrong, project paused, or a network blocking it. Open the URL in a tab — a paused project says so |
| `AADSTS50011: redirect URI mismatch` | Azure's redirect URI must be Supabase's `/auth/v1/callback`, not your site |
| Returns to the app but still signed out | The return URL is not in Supabase's **Redirect URLs** list |
| "The map_projects table does not exist yet" | Step 2 was not run |
| "The database refused that write" | Tables exist, policies do not. Re-run `sql/supabase-auth.sql` |
| "Sign-up is limited to dbotrealty.com" | The domain trigger. Change the domain in the SQL, or drop the trigger |
| Worked for weeks, then stopped | The Azure client secret expired. Issue a new one and update it in Supabase |

## What is not built yet

Stated so it is not discovered the hard way:

- **No conflict handling.** Two browsers editing one project is last-write-wins.
  Fine for one person on two machines; not safe for two people at once.
- **No sharing.** Projects are private to their owner. There is no way to give
  a colleague access.
- **Deletion is immediate**, with no recycle bin. The confirm dialog is the
  only safety net, which is why it names the project and offers a download.
