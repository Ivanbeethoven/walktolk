# Walktolk

把 OpenWalkieTalkie Rev A 接到 DeepSeek Harness（DSH）。在 deck 上可以翻看当前和历史会话，读最近回复，回答提问，批准或拒绝工具调用，也可以按住 PTT 向当前运行的助手说话。

**[读博客《按住对讲机说句话，DeepSeek Harness 回了一个 7》](docs/deck-and-dsh.md)** · [查看实机照片](docs/images/deck-session.jpg)

## 从哪里读代码

| 目录 | 运行位置 | 主要内容 |
| --- | --- | --- |
| [firmware/](firmware/) | OpenWalkieTalkie Rev A | 基于上游 `v0.14.0` 的完整源码，包含加密蓝牙控制服务、音频发送和设备界面。[设备协议](firmware/docs/deck-protocol.md) |
| [android-otg/](android-otg/) | Android 手机 | 通过蓝牙或 USB-OTG 连接 deck，经 WebSocket 转发控制和音频报文，也能打开 DSH 会话页面。 |
| [dsh-deck/](dsh-deck/) | 运行 DSH 的电脑 | DSH 插件，负责握手、会话名册、提问、审批和语音输入。[配置说明](dsh-deck/README.md) |
| [dsh/](https://github.com/Ivanbeethoven/deepseek-harness/tree/dsh-v0.2.1-rc.2) | 运行 DSH 的电脑 | DeepSeek Harness 源码，以 Git submodule 固定到与本机桌面版相符的 `dsh-v0.2.1-rc.2`。 |

## 取回整套源码

```powershell
git clone --recurse-submodules https://github.com/Ivanbeethoven/walktolk.git
```

已经克隆过仓库时，在项目根目录运行 `git pull --ff-only`，再运行 `git submodule update --init --recursive`。固件随 `main` 一起取回。两个上游项目在个人账号下各有一个 fork。[OpenWalkieTalkie fork](https://github.com/Ivanbeethoven/openwalkietalkie) · [DeepSeek Harness fork](https://github.com/Ivanbeethoven/deepseek-harness)

## 当前运行方式

deck 通过蓝牙连接手机，也可以用 USB 数据线直连手机。手机使用自己的网络访问中继，桌面插件以 `transport: remote` 接收报文。会话、工具执行和语音转录都由桌面的 DSH 提供，所以使用这套配置时电脑需要开机。直接把 deck 插在 Windows 电脑上时，插件也可以用 `transport: hid` 连接设备。

**固件升级。** 手机通过 USB-OTG 已在官方设备固件 `0.14.0` 上验证。手机通过蓝牙还需要 Deck Control GATT 服务，安卓应用配对后会按服务 UUID 自动识别。当前使用的是本仓库的 Rev A 固件。上游发布包含该服务的设备固件后，即可用官方版本继续连接同一个手机应用和桌面插件。[上游适配 PR #29](https://github.com/conol-ai/openwalkietalkie/pull/29)
