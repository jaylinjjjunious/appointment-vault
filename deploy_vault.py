import os
import subprocess

import modal

APP_NAME = "appointment-vault"
APP_DIR = "/app"
DATA_DIR = "/data"

app = modal.App(APP_NAME)

data_volume = modal.Volume.from_name("appointment-data", create_if_missing=True)

image = (
    modal.Image.debian_slim()
    .apt_install("curl", "gnupg", "ca-certificates")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
        "node --version",
        "npm --version",
    )
    .add_local_dir(".", remote_path=APP_DIR)
    .workdir(APP_DIR)
    .run_commands("npm install")
)


@app.function(
    image=image,
    volumes={DATA_DIR: data_volume},
)
@modal.web_server(port=3000)
def serve():
    env = os.environ.copy()
    env["DATA_DIR"] = DATA_DIR
    subprocess.run(["node", "src/app.js"], check=True, env=env, cwd=APP_DIR)
