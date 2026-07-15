import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


SAFETY = Path(__file__).resolve().parents[1]
UBUNTU_SCRIPT = SAFETY / "deploy-ubuntu-direct.sh"
WINDOWS_SCRIPT = SAFETY / "deploy-windows-bastion.ps1"
PREPARE_UBUNTU = SAFETY / "prepare-client-ubuntu.sh"
PREPARE_MACOS = SAFETY / "prepare-client-macos.sh"
PREPARE_WINDOWS = SAFETY / "prepare-client-windows.ps1"
USB_README_TEMPLATE = SAFETY / "usb-readme.template.txt"
UBUNTU_CONFIG = SAFETY / "site.ubuntu.conf.example"
WINDOWS_CONFIG = SAFETY / "site.windows.json.example"


def run(*args, check=True, env=None):
    process_env = os.environ.copy()
    process_env.update(env or {})
    return subprocess.run(
        [str(arg) for arg in args],
        cwd=SAFETY,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
        env=process_env,
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

    def test_client_preparation_scripts_generate_usb_safe_materials(self):
        run("bash", "-n", PREPARE_UBUNTU)
        run("bash", "-n", PREPARE_MACOS)
        ubuntu_source = PREPARE_UBUNTU.read_text()
        macos_source = PREPARE_MACOS.read_text()
        windows_source = PREPARE_WINDOWS.read_text()
        template = USB_README_TEMPLATE.read_text()

        for source in (ubuntu_source, macos_source, windows_source):
            self.assertIn("usb-readme.template.txt", source)
            self.assertNotIn("CZ Safety 现场部署 USB 包", source)
        self.assertIn("CZ Safety 现场部署 USB 包", template)
        self.assertNotIn('rm -rf "$OUTPUT_DIR"', ubuntu_source)
        self.assertNotIn('rm -rf "$OUTPUT_DIR"', macos_source)
        self.assertNotIn("Remove-Item -LiteralPath $OutputDir -Recurse", windows_source)
        self.assertNotIn("Desktop\\CZ-Safety-USB", windows_source)
        self.assertNotIn("$HOME/Desktop/CZ-Safety-USB", macos_source)
        self.assertIn("-N ''", windows_source)
        self.assertIn("-y -P ''", windows_source)
        self.assertNotIn("-N '\"\"'", windows_source)

        pwsh = find_pwsh()
        if pwsh:
            parser_command = (
                "$tokens=$null; $errors=$null; "
                "[System.Management.Automation.Language.Parser]::ParseFile($env:CZ_PS_PARSE_PATH, [ref]$tokens, [ref]$errors) | Out-Null; "
                "if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }"
            )
            run(
                pwsh,
                "-NoLogo",
                "-NoProfile",
                "-Command",
                parser_command,
                env={"CZ_PS_PARSE_PATH": str(PREPARE_WINDOWS)},
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            output = root / "usb"
            home.mkdir()
            prepare_env = {
                "HOME": str(home),
                "PYTHONPYCACHEPREFIX": str(root / "pycache"),
            }
            run(PREPARE_UBUNTU, output, env=prepare_env)

            admin_private = home / ".ssh" / "admin_ed25519"
            admin_public = home / ".ssh" / "admin_ed25519.pub"
            expected_usb_files = {
                output / "README.txt",
                output / "FOR-UBUNTU-SERVER" / "site.ubuntu.conf",
                output / "FOR-UBUNTU-SERVER" / "admin_authorized_keys",
                output / "FOR-WINDOWS-BASTION" / "site.windows.json",
                output / "FOR-WINDOWS-BASTION" / "bootstrap_ed25519",
                output / "FOR-WINDOWS-BASTION" / "bootstrap_ed25519.pub",
                output / "FOR-WINDOWS-BASTION" / "known_hosts",
            }
            self.assertTrue(admin_private.is_file())
            self.assertTrue(admin_public.is_file())
            self.assertEqual(admin_private.stat().st_mode & 0o777, 0o600)
            self.assertTrue(all(path.is_file() for path in expected_usb_files))
            self.assertFalse((output / "FOR-MY-MACHINE").exists())
            self.assertEqual(list(output.rglob("admin_ed25519")), [])

            windows_site_path = output / "FOR-WINDOWS-BASTION" / "site.windows.json"
            windows_site = json.loads(windows_site_path.read_text())
            comments = json.dumps(windows_site.get("_comment", {}), ensure_ascii=False)
            self.assertTrue(windows_site["_comment"]["adminPublicKey"].startswith("ssh-ed25519 "))
            self.assertNotIn(admin_private.read_text(), comments)
            self.assertNotIn((output / "FOR-WINDOWS-BASTION" / "bootstrap_ed25519").read_text(), comments)
            self.assertNotIn("PRIVATE KEY", comments)

            readme = (output / "README.txt").read_text()
            self.assertIn(str(admin_private), readme)
            self.assertNotIn("{{", readme)
            sentinel = output / "KEEP-ME"
            sentinel.write_text("do not delete")
            rerun = run(PREPARE_UBUNTU, output, check=False, env=prepare_env)
            self.assertNotEqual(rerun.returncode, 0)
            self.assertEqual(sentinel.read_text(), "do not delete")

    def test_ubuntu_script_syntax_self_test_preflight_and_plan(self):
        run("bash", "-n", UBUNTU_SCRIPT)
        self.assertIn("self-test PASS", run(UBUNTU_SCRIPT, "self-test").stdout)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "target-root"
            root.mkdir()
            contract_env = {"CZ_SAFETY_ROOT": str(root)}
            preflight_result = run(
                UBUNTU_SCRIPT,
                "preflight",
                "--config",
                UBUNTU_CONFIG,
                check=False,
                env=contract_env,
            )
            self.assertIn(preflight_result.returncode, {0, 2})
            preflight = json.loads(preflight_result.stdout)
            self.assertIn(preflight["status"], {"PENDING_UBUNTU_SITE", "BLOCKED", "PASS"})
            self.assertEqual(preflight_result.returncode, 2 if preflight["status"] == "BLOCKED" else 0)
            self.assertEqual(preflight["bmcAddress"], "192.168.100.10")

            plan = run(UBUNTU_SCRIPT, "plan", "--config", UBUNTU_CONFIG, env=contract_env).stdout
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

            nft_rules = plan.split("=== NFTABLES ===\n", 1)[1].split("\n=== SSHD DROP-IN ===", 1)[0]
            self.assertNotIn("elements = { }", nft_rules)
            self.assertIn("set admin_peers {\n    type ipv4_addr\n  }", nft_rules)
            self.assertIn("set employee_peers {\n    type ipv4_addr\n  }", nft_rules)
            nft = shutil.which("nft")
            if nft:
                nft_file = Path(directory) / "nftables.conf"
                nft_file.write_text(nft_rules)
                nft_result = run(nft, "-c", "-f", nft_file, check=False)
                nft_output = (nft_result.stdout + nft_result.stderr).lower()
                if nft_result.returncode and "operation not permitted" in nft_output and "syntax error" not in nft_output:
                    print("nft syntax check skipped: CAP_NET_ADMIN unavailable", file=sys.stderr)
                else:
                    self.assertEqual(nft_result.returncode, 0, nft_result.stderr)

            staged = Path(directory) / "staged.conf"
            staged.write_text(UBUNTU_CONFIG.read_text().replace("EGRESS_MODE=strict", "EGRESS_MODE=staged"))
            staged_plan = run(UBUNTU_SCRIPT, "plan", "--config", staged, env=contract_env).stdout
        self.assertIn("udp dport { 53, 123, 443 } accept", staged_plan)

    def test_ubuntu_rejects_network_address(self):
        invalid = UBUNTU_CONFIG.read_text().replace("203.0.113.106/30", "203.0.113.104/30")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.conf"
            path.write_text(invalid)
            result = run(UBUNTU_SCRIPT, "plan", "--config", path, check=False)
            alternate = Path(directory) / "alternate.conf"
            alternate.write_text(
                UBUNTU_CONFIG.read_text()
                .replace("203.0.113.106/30", "198.51.100.10/30")
                .replace("203.0.113.105", "198.51.100.9")
            )
            alternate_result = run(UBUNTU_SCRIPT, "plan", "--config", alternate, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("second usable address", result.stderr)
        self.assertEqual(alternate_result.returncode, 0, alternate_result.stderr)

    def test_ubuntu_offline_evidence_is_ready_but_runtime_pending(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as target_root:
            run(
                UBUNTU_SCRIPT,
                "evidence",
                "--config",
                UBUNTU_CONFIG,
                "--output-dir",
                directory,
                env={"CZ_SAFETY_ROOT": target_root},
            )
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
        self.assertIn("outside CZ-Safety across all firewall profiles", windows)
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
        self.assertIn("退出码为 2", readme)
        self.assertIn("不能写成“10/10”", readme)


if __name__ == "__main__":
    unittest.main()
