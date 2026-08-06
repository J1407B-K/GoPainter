// GoPainter wasm 入口：注册 JS 导出后常驻等待调用。
package main

func main() {
	registerJSExports()
	select {} // 挂着别退，等 JS 调用
}
