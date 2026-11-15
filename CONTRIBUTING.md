# 参与贡献

感谢你帮助改进 API 指纹巡检台。

## 可以贡献什么

- 新平台或新模型服务的兼容性反馈；
- macOS / Windows 启动和定时任务问题；
- 页面使用体验和文案改进；
- 通知渠道的使用说明；
- 不包含秘密信息的测试和修复。

## 提交问题前

请先确认：

1. 使用的是最新 Release；
2. 已完整解压发布包；
3. 设备、网络和模型服务本身可正常访问；
4. 已删除 API Key、Bark 设备 Key、Webhook URL、Bearer token、账号信息和本机数据路径中的敏感部分。

## 开发检查

```bash
npm ci --ignore-scripts
npm test
python3 -m unittest product_test.py
npm run check
```

测试使用合成凭据和模拟服务，不需要真实模型 Key，也不会安装系统定时任务或发送真实通知。

## Pull Request 建议

- 一个 Pull Request 只解决一个主要问题；
- 页面文案优先说明用户能完成什么，而不是内部实现；
- 不要在代码、截图、日志、测试样例或提交信息中放入真实凭据；
- 涉及费用、通知或系统任务的变更，应补充明确的用户确认和离线测试。
