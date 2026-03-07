# pi-memOS (memoh-lite) 架构总览

## 1. 核心架构哲学：混合微内核 (Hybrid Microkernel)
系统主体采用 TypeScript 作为控制平面 (Control Plane)，负责 Agent 沙箱的生命周期调度与大模型编排。而高并发、重 IO 的持久化操作则下沉至由 Rust 编写的底层 VFS 服务。
* **沙箱内 (Stateless Agent)**：运行在 containerd 内的纯计算节点，不持有任何持久化状态。
* **主控运行时 (TS Runtime)**：沙箱外的大脑，负责管理多会话的内存换页、上下文组装，以及调用大模型进行异步总结。
* **存储内核 (Rust VFS)**：通过 gRPC 与 TS Runtime 通信，全权接管 LanceDB 向量数据库与物理 JSON 文件的读写并发锁。

## 2. 双轨制记忆系统 (The Dual-Track Memory)
针对群聊数据的不同物理特性，我们将记忆彻底划分为“缓存流”与“全局状态”两条轨道：

### 轨道 A：会话缓存分级系统 (Session Cache Hierarchy)
专门处理 Append-only 的海量时间线对话，采用三级换页机制：
* **L0 (Active)**：驻留在 TS 内存中的极热数据，当前正在活跃交互的对话窗口。
* **L1 (Background)**：驻留在 TS 内存中的温数据，刚脱离活跃状态但随时可能被重新 `Reply` 唤醒的会话。
* **L2 (Archived)**：持久化冷数据。当 L1 被 LRU 淘汰时，通过大模型提取出中心向量 (Centroid Vector) 和摘要，连带 Telegram 原始消息打包落盘至 Rust 端的 LanceDB。

### 轨道 B：持久化状态注册表 (State Registry / Users VFS)
专门处理高频覆写的全局事实，脱离时间线束缚：
* **特征**：存储针对特定实体（如 User）的客观事实、偏好与社交拓扑关系。
* **机制**：由 TS Runtime 在后台触发 `ArchiveSession` 时，调用旁路模型提取出严格符合 Schema 的 JSON 补丁 (Patch)。通过 gRPC 交由 Rust 内核原子化地合并到宿主机 `data/state/users/` 对应的 JSON 文件中。沙箱内的 Agent 可通过 `mem://users/...` 的逻辑路径进行 100% 精确的确定性读取。