# 刷固件：0.7.0 → 0.15.0

你这台 deck 现在跑 **0.7.0**（2026 年 3 月左右的构建），仓库是 **0.15.0**。差的这 8 个版本里，
和你这个插件直接相关的有：

| 0.7.0 的表现 | 0.15.0 |
|---|---|
| 卡片最多 2 个选项，给 3 个会把整个会话踢掉 | 4 个选项 |
| `hm`（顶栏时钟）一进 hello 就被吞 | 正常 |
| 只有 agents / omarchy / macropad / usage / settings 五个面 | 多了 arcade / timer |
| 名册是平的 | 按 `proj` 分页 |

刷完这些坑全部消失，插件里的降级分支也就可以长期不用了。

## 为什么是 USB，不是拆机

我先查了 0.7.0 的源码（`git show v0.7.0:src/link/boot_info.rs`、`src/pmu.rs`），
它**已经带 USB recovery**：`RECOVERY_MARKER = "OpenWalkieTalkie Recovery 2 Rev A"`，
并且 `sys.reboot {mode:"recovery"}` 会经 PMU 的 BKP7R 写入 `OWTR` 魔数进恢复模式。

所以正常的路径是：**应用自己重启进 recovery → 通过同一个 USB HID 设备刷 → 校验 → 自动重启回应用**。
全程不拆机、不焊线、不用调试器。

> 只有当 bootloader 实在太老、根本不认 recovery 时，才需要退到 UART（TP6/TP8/TP4 焊盘 + sftool，
> 而且 `tools/flash-uart.py` 是 Unix-only，Windows 上得用 WSL）。到那一步我另给方案。

## 官方工具为什么不用

`tools/flash-usb.py` 依赖 Python 的 `hid` 模块（hidapi 绑定）。这台机器装不了它（网络半死、pip 拉不动），
所以我按同一套协议重写了一个 Node 版：`dsh-deck/bin/flash.mjs`，用的就是插件里已经跑通的
koffi → `hid.dll` 通道。协议常量、CRC、稀疏擦除、bonds 保护区全部照 `flash-usb.py` 对齐。

## 你需要先下载固件

固件不在 git 里，得从 release 拿（我这台机器访问不了 GitHub 网页，需要你手动下载）：

1. 打开 <https://github.com/conol-ai/openwalkietalkie/releases/latest>
   （国内网络也可试 <https://openwalkietalkie.org/> 的下载页）
2. 找 `OpenWalkieTalkie-0.15.0-...zip`，解压
3. 里面挑 **应用镜像**：`openwalkietalkie-fw`（ELF，首选）或 16 MiB 整片 bin 里的应用部分
   - 用 **ELF**：工具会按 PT_LOAD 段自己拼出要写的 flash 内容，最稳
   - 整片 `factory` bin **不要**直接喂给它（那是给离线烧录器的全片镜像，含分区表）
4. 把文件放到 `C:\Users\HXY\walktolk\` 下，比如 `openwalkietalkie-fw.elf`

## 步骤

```powershell
cd C:\Users\HXY\walktolk\dsh-deck

# 1. 插上 USB，确认设备在，并看它现在是什么模式
node bin/flash.mjs --status
#   还没刷过 → "attached, running: {version: 0.7.0-openwalkietalkie, board: Rev A}"
#   已在恢复模式 → "attached in recovery: protocol 2, image valid: ..."

# 2. 只验证镜像，一个字节都不写
node bin/flash.mjs --dry-run ..\openwalkietalkie-fw.elf
#   会打印：ELF / board Rev A / 字节数；并检查向量表、板子标识、bonds 区是否全 FF

# 3. 真刷
node bin/flash.mjs ..\openwalkietalkie-fw.elf
```

第 3 步它会依次做：

1. 读 `sys.version`，确认现在是哪个板子（Rev A / Rev B）
2. 发 `sys.reboot {mode:"recovery"}`，等设备以恢复模式重新枚举
3. `OP_BEGIN` 声明长度 → 按 4 KB 扇区写 `OP_DATA` → `OP_COMMIT`（带 CRC32）逐扇区校验
4. 跳过 `0x12700000–0x12720000`（蓝牙配对/设置，**永远不动**）
5. `OP_FINISH` 让 bootloader 校验向量表并重启
6. 轮询到应用回来，打印 `0.15.0-openwalkietalkie · Rev A`

## 如果卡住了

| 现象 | 处理 |
|---|---|
| `the deck did not come back in recovery mode` | 断电，**按住 SHIFT + CANCEL 再上电**（这是恢复模式的按键组合），然后 `node bin/flash.mjs --no-request <镜像>` |
| `no 1209:5754 interface on USB` | 换根线/换个口；device 上有些线只供电不传数据 |
| 刷到一半断电 | 应用区是唯一被写的区域，分区表和 bootloader 没动，**重刷同一个镜像即可恢复**（不用 JTAG） |
| `recovery protocol 1` | bootloader 是协议 1（更老），我的工具会警告但仍会尝试；失败就退到 UART |

## 刷完之后

```powershell
node bin/demo.mjs --seconds 60      # 名册 + 卡片，确认 4 选项那版行为
node bin/probe.mjs --lines          # 看 hello：应该能看到 fw 0.15.0 和 kinds/lang 字段
```

然后把插件的降级分支验证一遍：`caps.mjs` 里 0.15.0 会打开 `hm`、`maxChoices: 4`、`facesExtra`。

## 风险与边界

- 写的是**应用分区**（`0x12020000` 起），分区表和 bootloader 不会被碰——这就是为什么刷坏了还能再刷。
- 唯一真正危险的操作是覆盖 bootloader（`--bootloader`，`flash-usb.py` 里故意不写进 help），
  **我没有实现它**，也不建议在没有 UART 备份的情况下做。
- 刷之前请确保：USB 线插牢、别让机器睡眠、电量够（或插着电）。
