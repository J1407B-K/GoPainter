package main

import "testing"

// 测试向量来自 Python mmh3 包（标准 MurmurHash3 x86_32, seed 0）的实测输出，
// 其中 "foo" = -156908512 与既有冒烟测试 goMmh3("foo") 吻合，交叉验证过。
func TestMmh3Sum32(t *testing.T) {
	cases := []struct {
		in   string
		want int32
	}{
		{"", 0},
		{"foo", -156908512},
		{"abc", -1277324294},
		{"bar", 1158584717},
		{"foobar", -1530604355},
		{"Hello, world!", -1070186941},
		{"The quick brown fox jumps over the lazy dog", 776992547},
	}
	for _, c := range cases {
		if got := mmh3Sum32(c.in); got != c.want {
			t.Errorf("mmh3Sum32(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

// 中文按 UTF-8 字节算哈希，不应 panic、结果稳定
func TestMmh3Sum32Utf8(t *testing.T) {
	a := mmh3Sum32("致远OA")
	if a == 0 {
		t.Errorf("中文输入不应算出 0: %d", a)
	}
	b := mmh3Sum32("致远OA")
	if a != b {
		t.Errorf("同输入应稳定: %d != %d", a, b)
	}
}
