# Install and update Live Ops on Windows

You need **Docker Desktop** (running) and **Git for Windows**. Every command
below goes in **PowerShell**.

## First install

1. Get the code:

   ```powershell
   cd D:\projects
   git clone https://github.com/saketh269/liveops.git
   cd liveops
   ```

2. Create your settings file:

   ```powershell
   copy .env.example .env
   ```

3. Make a secret key and put it in `.env`:

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   $key = [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')
   (Get-Content .env) -replace '^LIVEOPS_SECRET_KEY=.*', "LIVEOPS_SECRET_KEY=$key" | Set-Content .env
   ```

   Keep `.env` safe and don't change the key later; it encrypts your saved passwords.

4. Start everything:

   ```powershell
   docker compose up --build -d
   ```

5. Open http://localhost:8080.

## Connecting to a database on your own computer

Use `host.docker.internal` as the host, not `localhost`. For a local test
database without TLS, set Encryption to **Off (local testing only)**. Company
databases should stay on **Required** or **Verify**.

## Update to a new version

```powershell
cd D:\projects\liveops
git pull
docker compose up --build -d
```

Your sources, sites, mappings and uploaded files are kept: the database and
upload folder live in Docker volumes, and migrations run automatically.

## Go back to the previous version

```powershell
git checkout v0.1.0      # or the tag you want
docker compose up --build -d
```

## Check it's healthy

```powershell
docker compose ps
```

All services should show `healthy` or `running`. In the app, the **Health**
page shows each mapping's status, lag and any errors with a hint.

## Stop it

```powershell
docker compose down
```

(Add `-v` only if you want to delete all saved data.)
