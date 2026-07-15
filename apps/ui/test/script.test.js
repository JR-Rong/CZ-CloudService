const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../../..");

function extractBashFunction(script, name) {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1);
  const nextFunction = script.indexOf("\n}\n\n", start);
  assert.notEqual(nextFunction, -1);
  return script.slice(start, nextFunction + 3);
}

test("Hermes contract smoke covers the standard profilectl lifecycle commands", () => {
  const scriptPath = path.join(repoRoot, "agent-platform/hermes-contract-smoke.sh");
  execFileSync("bash", ["-n", scriptPath]);
  const script = fs.readFileSync(scriptPath, "utf8");

  assert.match(script, /hermes-profilectl health --json/);
  assert.match(script, /hermes-profilectl list --json/);
  assert.match(script, /hermes-profilectl create --slug smoke --name Smoke --config-json -/);
  assert.match(script, /hermes-profilectl start smoke/);
  assert.match(script, /hermes-profilectl restart smoke/);
  assert.match(script, /hermes-profilectl stop smoke/);
  assert.match(script, /hermes-profilectl delete smoke/);
  assert.match(script, /--env-file "\$env_file"/);
  assert.doesNotMatch(script, /-e "OPENAI_API_KEY=\$API_KEY"/);
  assert.match(script, /command -v hermes-profilectl/);
  assert.match(script, /test ! -S \/var\/run\/docker\.sock/);
  assert.match(script, /require_json_object\(\)/);
  assert.match(script, /require_profile_count\(\)/);
  assert.match(script, /require_health_ready_private_model\(\)/);
  assert.match(script, /require_delete_missing\(\)/);
  assert.match(script, /privateModel\.privateOnly/);
  assert.match(script, /require_no_secret\(\)/);
  assert.match(script, /list_before_output=.*hermes-profilectl list --json/);
  assert.match(script, /create_output=.*hermes-profilectl create --slug smoke --name Smoke --config-json -/);
  assert.match(script, /create_again_output=.*hermes-profilectl create --slug smoke --name Smoke --config-json -/);
  assert.match(script, /list_after_output=.*hermes-profilectl list --json/);
  assert.match(script, /require_profile_count "list after create" "\$list_after_output" smoke 1/);
  assert.match(script, /start_output=.*hermes-profilectl start smoke/);
  assert.match(script, /restart_output=.*hermes-profilectl restart smoke/);
  assert.match(script, /stop_output=.*hermes-profilectl stop smoke/);
  assert.match(script, /delete_output=.*hermes-profilectl delete smoke/);
  assert.match(script, /list_after_delete_output=.*hermes-profilectl list --json/);
  assert.match(script, /require_profile_count "list after delete" "\$list_after_delete_output" smoke 0/);
  assert.match(script, /delete_missing_output=.*hermes-profilectl delete smoke/);
  assert.match(script, /require_delete_missing "delete missing" "\$delete_missing_output"/);
  assert.match(script, /all_outputs=/);
  assert.match(script, /require_no_secret "contract command outputs" "\$all_outputs"/);
});

test("Hermes contract smoke accepts multiline JSON command output", () => {
  const script = fs.readFileSync(path.join(repoRoot, "agent-platform/hermes-contract-smoke.sh"), "utf8");
  const helper = extractBashFunction(script, "require_json_object");

  execFileSync("bash", [
    "-c",
    `${helper}
require_json_object "pretty json" $'{\\n  "status": "ready"\\n}'`,
  ]);
});

test("Hermes contract smoke validates health private model metadata", () => {
  const script = fs.readFileSync(path.join(repoRoot, "agent-platform/hermes-contract-smoke.sh"), "utf8");
  const helper = extractBashFunction(script, "require_health_ready_private_model");

  execFileSync("bash", [
    "-c",
    `${helper}
BASE_URL="http://192.168.100.12:8000/v1" MODEL="qwen3.6-35b-a3b" require_health_ready_private_model $'{
  "status": "ready",
  "privateModel": {
    "baseUrl": "http://192.168.100.12:8000/v1",
    "model": "qwen3.6-35b-a3b",
    "privateOnly": true
  }
}'`,
  ]);

  assert.throws(() =>
    execFileSync("bash", [
      "-c",
      `${helper}
BASE_URL="http://192.168.100.12:8000/v1" MODEL="qwen3.6-35b-a3b" require_health_ready_private_model '{"status":"ready"}'`,
    ], { stdio: "pipe" }),
  );
});

test("Hermes contract smoke validates missing delete responses", () => {
  const script = fs.readFileSync(path.join(repoRoot, "agent-platform/hermes-contract-smoke.sh"), "utf8");
  const helper = extractBashFunction(script, "require_delete_missing");

  execFileSync("bash", [
    "-c",
    `${helper}
require_delete_missing "delete missing" '{"missing":true}'`,
  ]);

  assert.throws(() =>
    execFileSync("bash", [
      "-c",
      `${helper}
require_delete_missing "delete missing" '{"deleted":true}'`,
    ], { stdio: "pipe" }),
  );
});

test("Hermes wrapper profilectl implements the Phase 0 file-backed contract", () => {
  const wrapperDir = path.join(repoRoot, "agent-platform/hermes-wrapper");
  const ctlPath = path.join(wrapperDir, "hermes-profilectl.js");
  const dockerfile = fs.readFileSync(path.join(wrapperDir, "Dockerfile"), "utf8");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-profilectl-"));
  const secret = "super-secret-test-key";
  const env = {
    ...process.env,
    HERMES_PROFILE_DATA_DIR: dataDir,
    OPENAI_BASE_URL: "http://192.168.100.12:8000/v1",
    OPENAI_API_BASE: "http://192.168.100.12:8000/v1",
    OPENAI_MODEL: "qwen3.6-35b-a3b",
    LOCAL_LLM_MODEL: "qwen3.6-35b-a3b",
    OPENAI_API_KEY: secret,
    HERMES_PRIVATE_MODEL_ONLY: "1",
    HERMES_OWNER_ID: "usr_test",
    HERMES_EMPLOYEE_USERNAME: "alice",
  };

  assert.match(dockerfile, /ARG HERMES_BASE_IMAGE=node:22-alpine/);
  assert.match(dockerfile, /COPY hermes-profilectl\.js \/usr\/local\/bin\/hermes-profilectl/);

  const run = (args, input = "") => {
    const output = execFileSync(process.execPath, [ctlPath, ...args], {
      env,
      input,
    }).toString();
    assert.doesNotMatch(output, new RegExp(secret));
    return JSON.parse(output);
  };

  assert.deepEqual(run(["health", "--json"]), {
    status: "ready",
    privateModel: {
      baseUrl: "http://192.168.100.12:8000/v1",
      model: "qwen3.6-35b-a3b",
      privateOnly: true,
    },
  });

  const payload = JSON.stringify({
    version: 1,
    slug: "smoke",
    displayName: "Smoke",
    description: "Contract smoke profile.",
    model: {
      provider: "openai-compatible",
      baseUrl: "http://192.168.100.12:8000/v1",
      model: "qwen3.6-35b-a3b",
      privateOnly: true,
    },
    bindings: [],
    resources: [],
  });

  assert.equal(run(["create", "--slug", "smoke", "--name", "Smoke", "--config-json", "-"], payload).status, "stopped");
  assert.equal(run(["create", "--slug", "smoke", "--name", "Smoke", "--config-json", "-"], payload).updated, true);
  assert.deepEqual(run(["list", "--json"]).profiles.map((profile) => profile.slug), ["smoke"]);
  assert.equal(run(["start", "smoke"]).status, "running");
  assert.equal(run(["restart", "smoke"]).status, "running");
  assert.equal(run(["stop", "smoke"]).status, "stopped");
  assert.equal(run(["delete", "smoke"]).deleted, true);
  assert.equal(run(["delete", "smoke"]).missing, true);
  assert.deepEqual(run(["list", "--json"]), { version: 1, profiles: [] });
});

test("cloud frps script dry-run supports web console and LLM ports", () => {
  execFileSync("bash", ["-n", path.join(repoRoot, "scripts/cloud/setup-frps.sh")]);
  const defaultOutput = execFileSync("bash", [path.join(repoRoot, "scripts/cloud/setup-frps.sh")]).toString();
  const output = execFileSync("bash", [
    path.join(repoRoot, "scripts/cloud/setup-frps.sh"),
    "--allow-ports",
    "2222,2444,9000,9999",
  ]).toString();

  assert.match(defaultOutput, /\{ start = 2222, end = 2222 \}/);
  assert.match(defaultOutput, /\{ start = 2444, end = 2444 \}/);
  assert.match(defaultOutput, /\{ start = 9000, end = 9000 \}/);
  assert.match(defaultOutput, /\{ start = 9999, end = 9999 \}/);
  assert.match(output, /\{ start = 2222, end = 2222 \}/);
  assert.match(output, /\{ start = 2444, end = 2444 \}/);
  assert.match(output, /\{ start = 9000, end = 9000 \}/);
  assert.match(output, /\{ start = 9999, end = 9999 \}/);
});

test("cloud frps diagnostic script checks listeners, allowPorts, and web proxy logs", () => {
  const scriptPath = path.join(repoRoot, "scripts/cloud/check-frps-agent-platform.sh");
  execFileSync("bash", ["-n", scriptPath]);
  const script = fs.readFileSync(scriptPath, "utf8");

  assert.match(script, /systemctl is-active/);
  assert.match(script, /ss -tlnp/);
  assert.match(script, /FRPS_CONFIG="\$\{FRPS_CONFIG:-\/etc\/frp\/frps\.toml\}"/);
  assert.match(script, /FRPS_LOG="\$\{FRPS_LOG:-\/var\/log\/frps\.log\}"/);
  assert.match(script, /CONTROL_PORT="\$\{FRPS_BIND_PORT:-7000\}"/);
  assert.match(script, /SSH_PORT="\$\{FRPS_SSH_PORT:-2222\}"/);
  assert.match(script, /WEB_PORT="\$\{FRPS_WEB_PORT:-2444\}"/);
  assert.match(script, /LLM_PORT="\$\{FRPS_LLM_PORT:-9000\}"/);
  assert.match(script, /AI_CHAT_WEB_PORT="\$\{FRPS_AI_CHAT_WEB_PORT:-9999\}"/);
  assert.match(script, /allowPorts/);
  assert.match(script, /hermes-agent-web-\$WEB_PORT/);
  assert.match(script, /ai-llm-qwen36-\$LLM_PORT/);
  assert.match(script, /ai-chat-web-\$AI_CHAT_WEB_PORT/);
});

test("windows frpc setup script defines SSH, Hermes web, LLM, and AI chat web proxy blocks", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts/windows/setup-frpc.ps1"), "utf8");

  assert.match(script, /windows-ssh-\$RemotePort/);
  assert.match(script, /hermes-agent-web-\$AgentWebRemotePort/);
  assert.match(script, /ai-llm-qwen36-\$LlmRemotePort/);
  assert.match(script, /ai-chat-web-\$AiChatWebRemotePort/);
  assert.match(script, /\[\[proxies\]\]/g);
  assert.match(script, /localPort = \$AgentWebLocalPort/);
  assert.match(script, /remotePort = \$AgentWebRemotePort/);
  assert.match(script, /localIP = \$\(Convert-ToTomlString \$LlmLocalIP\)/);
  assert.match(script, /localPort = \$LlmLocalPort/);
  assert.match(script, /remotePort = \$LlmRemotePort/);
  assert.match(script, /localIP = \$\(Convert-ToTomlString \$AiChatWebLocalIP\)/);
  assert.match(script, /localPort = \$AiChatWebLocalPort/);
  assert.match(script, /remotePort = \$AiChatWebRemotePort/);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$currentUser -LogonType Interactive -RunLevel Limited/);
  assert.doesNotMatch(script, /LeastPrivilege/);
});

test("windows frpc setup script supports delayed detached restart for FRP SSH sessions", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts/windows/setup-frpc.ps1"), "utf8");

  assert.match(script, /\[switch\]\$RestartExistingDetached/);
  assert.match(script, /\[int\]\$RestartDelaySeconds = 5/);
  assert.match(script, /function Start-DetachedFrpcRestart/);
  assert.match(script, /Start-Sleep -Seconds \$DelaySeconds/);
  assert.match(script, /Stop-ExistingFrpc -TargetInstallDir \$TargetInstallDir/);
  assert.match(script, /Start-Process -FilePath 'powershell'/);
  assert.match(script, /\$RestartExistingDetached -and \$NoStart/);
});

test("windows app setup script carries runtime LLM key into scheduled task launcher", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts/windows/setup-agent-platform.ps1"), "utf8");

  assert.match(script, /ValidateSet\("AtLogon", "AtStartup"\)/);
  assert.match(script, /\[string\]\$ScheduledTaskTrigger = "AtLogon"/);
  assert.match(script, /\[string\]\$NodeExe = ""/);
  assert.match(script, /\[Environment\]::ExpandEnvironmentVariables\(\$NodeExe\)/);
  assert.match(script, /Test-Path \$nodeExe -PathType Leaf/);
  assert.match(script, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId "SYSTEM"/);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$currentUser -LogonType Interactive -RunLevel Limited/);
  assert.doesNotMatch(script, /LeastPrivilege/);
  assert.match(script, /GetEnvironmentVariable\(\$LocalLlmApiKeyEnv\)/);
  assert.match(script, /\$DockerManagerMode -eq "real"/);
  assert.match(script, /Missing runtime LLM API key/);
  assert.match(script, /set `"\$LocalLlmApiKeyEnv=\$localLlmApiKey`"/);
  assert.match(script, /set "BOOTSTRAP_ADMIN_PASSWORD=\$BootstrapAdminPassword"/);
});

test("deployment guide documents portable Node for Windows app setup", () => {
  const guide = fs.readFileSync(path.join(repoRoot, "docs/agent-platform/deployment-guide.md"), "utf8");

  assert.match(guide, /-NodeExe "C:\\Users\\chuan\\node-portable\\node\.exe"/);
  assert.match(guide, /when Node\.js is not on `PATH`/);
});

test("deployment guide verifies public web access without local HTTP proxies", () => {
  const guide = fs.readFileSync(path.join(repoRoot, "docs/agent-platform/deployment-guide.md"), "utf8");

  assert.match(guide, /curl --noproxy '\*' -i http:\/\/60\.205\.213\.254:2444\//);
  assert.match(guide, /scripts\/cloud\/check-frps-agent-platform\.sh/);
  assert.match(guide, /scripts\\windows\\check-agent-platform\.ps1/);
});

test("deployment guide documents Windows frpc recovery when public proxies disappear", () => {
  const guide = fs.readFileSync(path.join(repoRoot, "docs/agent-platform/deployment-guide.md"), "utf8");

  assert.match(guide, /ECS shows only `7000`/);
  assert.match(guide, /frpc\.exe" verify -c "\$frp\\frpc\.toml"/);
  assert.match(guide, /Start-Process -FilePath "\$frp\\frp_0\.69\.1_windows_amd64\\frpc\.exe"/);
  assert.match(guide, /Start-ScheduledTask -TaskName "CZ Hermes Agent Platform"/);
  assert.match(guide, /RestartExistingDetached/);
});

test("FRP runbooks distinguish cloud ingress from a healthy local LLM proxy", () => {
  const serverGuide = fs.readFileSync(path.join(repoRoot, "docs/frp/server-deployment-guide.md"), "utf8");
  const windowsGuide = fs.readFileSync(path.join(repoRoot, "docs/frp/windows-client-deployment-guide.md"), "utf8");
  const aiRunbook = fs.readFileSync(path.join(repoRoot, "docs/ai-stack/runbook.md"), "utf8");

  assert.match(serverGuide, /127\.0\.0\.1:9000\/health/);
  assert.match(serverGuide, /tcpdump -nni any tcp port 9000/);
  assert.match(serverGuide, /cloud security\s+group or EIP ingress rule/);
  assert.match(windowsGuide, /127\.0\.0\.1:9000\/health/);
  assert.match(windowsGuide, /tcpdump -nni any tcp port 9000/);
  assert.match(aiRunbook, /cloud security group or EIP ingress/);
});

test("deployment guide documents the full Hermes contract smoke coverage", () => {
  const guide = fs.readFileSync(path.join(repoRoot, "docs/agent-platform/deployment-guide.md"), "utf8");

  assert.match(guide, /hermes-profilectl` is on `PATH`/);
  assert.match(guide, /Docker socket is not exposed/);
  assert.match(guide, /temporary env file/);
  assert.match(guide, /private model metadata/);
  assert.match(guide, /profile start\/restart\/stop\/delete/);
  assert.match(guide, /no API key in the captured command outputs/);
});

test("windows agent platform diagnostic script checks web app and FRP chain", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts/windows/check-agent-platform.ps1"), "utf8");

  assert.match(script, /Invoke-WebRequest/);
  assert.match(script, /http:\/\/127\.0\.0\.1:\$Port\//);
  assert.match(script, /Get-Process frpc/);
  assert.match(script, /Get-Command docker/);
  assert.match(script, /com\.docker\.service/);
  assert.match(script, /sc\.exe query \$ServiceName/);
  assert.match(script, /Test-DockerService "docker"/);
  assert.match(script, /DOCKER_MANAGER_MODE/);
  assert.match(script, /start-agent-platform\.cmd/);
  assert.match(script, /Test-Task "agent platform scheduled task" \$AgentTaskName/);
  assert.match(script, /Test-Task "frpc scheduled task" \$FrpcTaskName/);
  assert.match(script, /Test-NetConnection -ComputerName \$PublicHost -Port \$PublicPort/);
  assert.match(script, /Invoke-WebRequest .* -Proxy \$null/);
  assert.match(script, /hermes-agent-web-\$PublicPort/);
});

test("local acceptance runner captures repeatable Phase 5 checks", () => {
  const scriptPath = path.join(repoRoot, "agent-platform/local-acceptance.sh");
  execFileSync("bash", ["-n", scriptPath]);
  const script = fs.readFileSync(scriptPath, "utf8");

  assert.match(script, /node --test --test-reporter=spec test\/\*\.test\.js/);
  assert.match(script, /node --check src\/server\.js src\/store\.js src\/docker\.js src\/secrets\.js public\/app\.js \.\.\/\.\.\/agent-platform\/hermes-wrapper\/hermes-profilectl\.js/);
  assert.match(script, /bash -n agent-platform\/hermes-contract-smoke\.sh scripts\/cloud\/setup-frps\.sh scripts\/cloud\/check-frps-agent-platform\.sh/);
  assert.match(script, /bash scripts\/cloud\/setup-frps\.sh --allow-ports 2222,2444,9000,9999/);
  assert.match(script, /scripts\/cloud\/check-frps-agent-platform\.sh/);
  assert.match(script, /git diff --check/);
  assert.match(script, /command -v pwsh/);
  assert.match(script, /RUN_PUBLIC_SMOKE/);
  assert.match(script, /curl --noproxy '\*'/);
  assert.match(script, /agent-platform\/hermes-contract-smoke\.sh/);
  assert.match(script, /DOCKER real-mode smoke is external/);
});
