import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


SAFETY = Path(__file__).resolve().parents[1]
UBUNTU_SCRIPT = SAFETY / "deploy-ubuntu-direct.sh"
WINDOWS_SCRIPT = SAFETY / "deploy-windows-bastion.ps1"
UBUNTU_CONFIG = SAFETY / "site.ubuntu.conf.example"
WINDOWS_CONFIG = SAFETY / "site.windows.json.example"


def run(*args, check=True):
    return subprocess.run(
        [str(arg) for arg in args],
        cwd=SAFETY,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def find_pwsh():
    configured = os.environ.get("PWSH")
    if configured:
        return configured
    return shutil.which("pwsh")


class OfflineContractTests(unittest.TestCase):
    def test_exactly_two_deployment_entry_scripts(self):
        scripts = sorted(
            path.name
            for path in SAFETY.iterdir()
            if path.is_file() and path.name.startswith("deploy-") and path.suffix in {".sh", ".ps1"}
        )
        self.assertEqual(scripts, ["deploy-ubuntu-direct.sh", "deploy-windows-bastion.ps1"])

    def test_ubuntu_script_syntax_self_test_preflight_and_plan(self):
        run("bash", "-n", UBUNTU_SCRIPT)
        self.assertIn("self-test PASS", run(UBUNTU_SCRIPT, "self-test").stdout)
        preflight = json.loads(run(UBUNTU_SCRIPT, "preflight", "--config", UBUNTU_CONFIG).stdout)
        self.assertEqual(preflight["status"], "PENDING_UBUNTU_SITE")
        self.assertEqual(preflight["bmcAddress"], "192.168.100.10")
        plan = run(UBUNTU_SCRIPT, "plan", "--config", UBUNTU_CONFIG).stdout
        for required in (
            "policy drop",
            "udp dport 51820 accept",
            "udp dport { 53, 123 } accept",
            "PasswordAuthentication no",
            'ip daddr 192.168.100.10 tcp dport 443 accept',
            "PrivateKey = <redacted>",
        ):
            self.assertIn(required, plan)
        self.assertNotIn("udp dport { 53, 123, 443 } accept", plan)
        with tempfile.TemporaryDirectory() as directory:
            staged = Path(directory) / "staged.conf"
            staged.write_text(UBUNTU_CONFIG.read_text().replace("EGRESS_MODE=strict", "EGRESS_MODE=staged"))
            staged_plan = run(UBUNTU_SCRIPT, "plan", "--config", staged).stdout
        self.assertIn("udp dport { 53, 123, 443 } accept", staged_plan)

    def test_ubuntu_rejects_network_address(self):
        invalid = UBUNTU_CONFIG.read_text().replace("203.0.113.106/30", "203.0.113.104/30")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.conf"
            path.write_text(invalid)
            result = run(UBUNTU_SCRIPT, "plan", "--config", path, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("second usable address", result.stderr)

    def test_ubuntu_offline_evidence_is_ready_but_runtime_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            run(UBUNTU_SCRIPT, "evidence", "--config", UBUNTU_CONFIG, "--output-dir", directory)
            report = json.loads((Path(directory) / "acceptance.json").read_text())
        self.assertEqual(report["status"], "READY_FOR_SITE")
        self.assertEqual(report["publicNetworkRuntime"], "PENDING_SITE")

    def test_windows_example_address_contract(self):
        site = json.loads(WINDOWS_CONFIG.read_text())
        wan = ipaddress.ip_interface(site["public"]["cidr"])
        hosts = list(wan.network.hosts())
        self.assertEqual(wan.network.prefixlen, 30)
        self.assertEqual(str(hosts[0]), site["public"]["gateway"])
        self.assertEqual(wan.ip, hosts[1])
        self.assertEqual(site["bmc"]["address"], "192.168.100.10")
        self.assertEqual(site["bmc"]["mode"], "flat-bmc")

    @unittest.skipUnless(find_pwsh(), "pwsh is not installed; use PWSH=/path/to/pwsh for the full test")
    def test_windows_script_parse_self_test_preflight_and_plan(self):
        pwsh = find_pwsh()
        self.assertIn("self-test PASS", run(pwsh, "-NoLogo", "-NoProfile", "-File", WINDOWS_SCRIPT, "-Action", "SelfTest").stdout)
        preflight = json.loads(
            run(
                pwsh,
                "-NoLogo",
                "-NoProfile",
                "-File",
                WINDOWS_SCRIPT,
                "-Action",
                "Preflight",
                "-Config",
                WINDOWS_CONFIG,
            ).stdout
        )
        self.assertEqual(preflight["status"], "PENDING_WINDOWS_SITE")
        plan = json.loads(
            run(
                pwsh,
                "-NoLogo",
                "-NoProfile",
                "-File",
                WINDOWS_SCRIPT,
                "-Action",
                "Plan",
                "-Config",
                WINDOWS_CONFIG,
            ).stdout
        )
        self.assertEqual(plan["public"]["allowedInbound"], ["UDP/51820"])
        self.assertEqual(plan["bmc"]["browserUrl"], "https://192.168.100.10")
        with tempfile.TemporaryDirectory() as directory:
            run(
                pwsh,
                "-NoLogo",
                "-NoProfile",
                "-File",
                WINDOWS_SCRIPT,
                "-Action",
                "Evidence",
                "-Config",
                WINDOWS_CONFIG,
                "-OutputDir",
                directory,
            )
            report = json.loads((Path(directory) / "acceptance.json").read_text(encoding="utf-8-sig"))
        self.assertEqual(report["status"], "READY_FOR_SITE")
        self.assertEqual(report["publicNetworkRuntime"], "PENDING_SITE")

    def test_safety_controls_are_present_in_both_scripts(self):
        ubuntu = UBUNTU_SCRIPT.read_text()
        windows = WINDOWS_SCRIPT.read_text()
        for source in (ubuntu, windows):
            self.assertIn("PasswordAuthentication no", source)
            self.assertIn("policy drop", source)
            self.assertIn("192.168.100.10", source)
            self.assertIn("rollback", source.lower())
        self.assertIn("--confirm-external", ubuntu)
        self.assertIn("if ! id -nG", ubuntu)
        self.assertIn("ConfirmExternal", windows)
        self.assertIn("Port ${sshPort}", windows)
        self.assertIn("briefly disconnects every active peer", windows)
        self.assertNotIn("Invoke-Expression", windows)

    def test_repository_contains_no_embedded_private_key(self):
        forbidden_pem = re.compile(r"-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----")
        wireguard_secret = re.compile(r"PrivateKey\s*=\s*[A-Za-z0-9+/]{42,44}={0,2}\s*$", re.MULTILINE)
        for path in SAFETY.rglob("*"):
            if not path.is_file() or any(part in {"dist", "evidence", ".work", "__pycache__"} for part in path.parts):
                continue
            text = path.read_text(errors="ignore")
            self.assertIsNone(forbidden_pem.search(text), path)
            self.assertIsNone(wireguard_secret.search(text), path)

    def test_documented_acceptance_is_truthful_while_server_is_off(self):
        readme = (SAFETY / "README.md").read_text()
        acceptance = (SAFETY / "ACCEPTANCE.md").read_text()
        self.assertIn("READY_FOR_SITE", readme)
        self.assertIn("PENDING_SITE", readme)
        self.assertIn("ACCEPTED_SITE", acceptance)
        self.assertIn("服务器关机不构成失败", acceptance)
        self.assertIn("只有两个", acceptance)


if __name__ == "__main__":
    unittest.main()
