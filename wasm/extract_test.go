package main

import "testing"

func TestExtractTitle(t *testing.T) {
	html := `<html><head><title>   My   Big \n Page </title></head></html>`
	e := extractFeatures(html)
	if e.Title != "My Big \\n Page" {
		t.Errorf("title 应裁剪空白并折叠: %q", e.Title)
	}
}

func TestExtractTitleWithAttrs(t *testing.T) {
	html := `<title data-id="1">Hello</title>`
	e := extractFeatures(html)
	if e.Title != "Hello" {
		t.Errorf("title 带属性应正常提取: %q", e.Title)
	}
}

func TestExtractMeta(t *testing.T) {
	html := `
		<meta name="generator" content="WordPress 6.5">
		<meta property="og:title" content="Hello World">
		<meta name="empty" content="">
		<meta name="no-content-attr">
	`
	e := extractFeatures(html)
	if e.Meta["generator"] != "WordPress 6.5" {
		t.Errorf("meta name 应提取: %+v", e.Meta)
	}
	if e.Meta["og:title"] != "Hello World" {
		t.Errorf("meta property 应提取: %+v", e.Meta)
	}
	if _, ok := e.Meta["empty"]; ok {
		t.Error("content 为空的 meta 应跳过")
	}
	if _, ok := e.Meta["no-content-attr"]; ok {
		t.Error("无 content 属性的 meta 应跳过")
	}
}

func TestExtractMetaLowercase(t *testing.T) {
	html := `<meta NAME="Generator" CONTENT="X">`
	e := extractFeatures(html)
	if e.Meta["generator"] != "X" {
		t.Errorf("meta key 应小写化: %+v", e.Meta)
	}
}

func TestExtractScripts(t *testing.T) {
	html := `<script src="/a.js"></script><script src="https://cdn.example.com/b.js"></script><script>inline()</script>`
	e := extractFeatures(html)
	if len(e.Scripts) != 2 || e.Scripts[0] != "/a.js" || e.Scripts[1] != "https://cdn.example.com/b.js" {
		t.Errorf("scripts 应只收带 src 的: %+v", e.Scripts)
	}
}

func TestExtractFavicons(t *testing.T) {
	html := `
		<link rel="icon" href="/favicon.ico">
		<link rel="shortcut icon" href="/shortcut.ico">
		<link rel="stylesheet" href="/style.css">
		<link rel="apple-touch-icon" href="/apple.png">
	`
	e := extractFeatures(html)
	if len(e.Favicons) != 3 {
		t.Fatalf("favicons 应收 rel 含 icon 的 3 个: %+v", e.Favicons)
	}
	for _, want := range []string{"/favicon.ico", "/shortcut.ico", "/apple.png"} {
		found := false
		for _, got := range e.Favicons {
			if got == want {
				found = true
			}
		}
		if !found {
			t.Errorf("favicons 缺 %s: %+v", want, e.Favicons)
		}
	}
}

func TestExtractLinks(t *testing.T) {
	html := `<a href="/about">About</a><a href="https://other.example.com">Ext</a><a>NoHref</a>`
	e := extractFeatures(html)
	if len(e.Links) != 2 {
		t.Fatalf("links 应收 2 个: %+v", e.Links)
	}
}

func TestExtractEmpty(t *testing.T) {
	e := extractFeatures("")
	if e.Title != "" || len(e.Meta) != 0 || len(e.Scripts) != 0 || len(e.Favicons) != 0 || len(e.Links) != 0 {
		t.Errorf("空 HTML 应全空: %+v", e)
	}
}

func TestExtractSingleQuotedAttrs(t *testing.T) {
	html := `<meta name='kw' content='v'>`
	e := extractFeatures(html)
	if e.Meta["kw"] != "v" {
		t.Errorf("单引号属性应支持: %+v", e.Meta)
	}
}
