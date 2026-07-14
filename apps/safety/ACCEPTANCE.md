# 验收目标

## 当前离线验收：READY_FOR_SITE

服务器关机不构成失败。当前验收只证明部署材料可以安全带到现场，必须同时满足：

- 仓库根目录下只有两个网络安全部署入口：Windows PowerShell 与 Ubuntu Bash。
- 两个脚本都通过真实解释器的语法解析、自测、示例 `preflight` 和 `plan`。
- `.104` 网络地址、文档地址和不完整配置不能执行 `Apply`。
- 公网入站渲染结果只有 WireGuard UDP；公网 SSH/RDP/SMB/WinRM 不开放。
- SSH 禁用 root、密码和交互式口令认证，仅管理员组公钥可用。
- Admin/Employee 使用不重叠的地址段，员工不能 SSH 或访问 BMC。
- BMC 固定为 `192.168.100.10`，从不分配公网地址。
- `Apply` 要求本地控制台确认、先备份并启动 20 分钟自动回滚；`Confirm` 要求声明真实外部测试已通过。
- 仓库不包含私钥、真实公网配置或运行时 peer 配置；交付包包含 SHA-256 清单。

离线验证命令：

```bash
python3 -m unittest -v apps/safety/tests/test_offline_contract.py
```

## 现场运行验收：PENDING_SITE

选择实际拓扑后只执行对应脚本。以下证据全部通过，状态才能从 `PENDING_SITE` 改为 `ACCEPTED_SITE`：

| 编号 | 目标 | 通过标准 |
|---|---|---|
| S01 | 可信系统 | Ubuntu 为重装/可信 24.04 基线；旧盘已离线取证或隔离；所有旧凭据已轮换 |
| S02 | 地址和接线 | `.105` 是默认网关、`.106/30` 只在选定边界设备；`.104/.107` 未配置；接口/MAC/交换机端口留档 |
| S03 | 公网最小暴露 | 外部扫描只看到选定的 WireGuard UDP；TCP 22/3389/445/5985/5986 和业务端口均不可达 |
| S04 | 管理员 VPN | 独立 Admin peer 完成最新握手，隧道内 SSH 公钥登录成功 |
| S05 | 非 VPN 拒绝 | 停用 WireGuard 后，同一外部测试机无法 SSH、RDP、访问业务或 BMC |
| S06 | 员工隔离 | Employee peer 可访问明确允许的 HTTPS，但 SSH、RDP 管理和 BMC 均失败 |
| S07 | BMC 隔离 | BMC 仍为 `192.168.100.10`；Ubuntu 模式只允许 Admin VPN 访问配置的单一 Web 端口；Windows 模式只在 Windows 本地浏览器访问 |
| S08 | SSH 加固 | `PermitRootLogin no`、`PasswordAuthentication no`、`AllowGroups safety-admin` 生效；错误密钥失败 |
| S09 | 回滚 | 在测试配置上证明未 Confirm 会自动回滚；错误配置可从本地控制台手动 Rollback |
| S10 | 持久化 | 边界设备和 Ubuntu 各重启一次后，防火墙默认拒绝、WireGuard、SSH 策略和路由保持 |
| S11 | 日志和时间 | 系统时间正确；nftables/Windows Firewall、SSH、WireGuard、auditd 日志可采集且无私钥 |
| S12 | 证据归档 | `Evidence` 输出、外部扫描结果、握手时间、拒绝测试、重启测试、配置哈希和接线照片归档 |

建议从不在该 `/30` 内的外部网络运行 TCP 扫描，并分别用 Admin 与 Employee peer 测试。UDP 扫描常把 WireGuard 显示为 `open|filtered`，因此必须同时以服务端 `wg show` 的最新握手作为成功证据，不能只看扫描器结果。

任何一项未执行都应保持 `PENDING_SITE`，不能写成“已通过”或“已上线”。
