// mmh3（MurmurHash3 x86_32），算 fofa 的 favicon 哈希用。
package engine

import "math/bits"

func mmh3Sum32(data string) int32 {
	const (
		c1 = 0xcc9e2d51
		c2 = 0x1b873593
	)
	var h uint32
	n := len(data)
	rounded := n &^ 3

	for i := 0; i < rounded; i += 4 {
		k := uint32(data[i]) | uint32(data[i+1])<<8 | uint32(data[i+2])<<16 | uint32(data[i+3])<<24
		k *= c1
		k = bits.RotateLeft32(k, 15)
		k *= c2
		h ^= k
		h = bits.RotateLeft32(h, 13)
		h = h*5 + 0xe6546b64
	}

	var k uint32
	switch n & 3 {
	case 3:
		k ^= uint32(data[rounded+2]) << 16
		fallthrough
	case 2:
		k ^= uint32(data[rounded+1]) << 8
		fallthrough
	case 1:
		k ^= uint32(data[rounded])
		k *= c1
		k = bits.RotateLeft32(k, 15)
		k *= c2
		h ^= k
	}

	h ^= uint32(n)
	h ^= h >> 16
	h *= 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return int32(h)
}
