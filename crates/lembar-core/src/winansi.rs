/// Encodes text for a standard Type 1 font using `/WinAnsiEncoding`
/// (Windows-1252). Characters the encoding lacks become `?`.
pub fn encode(text: &str) -> Vec<u8> {
    text.chars().map(encode_char).collect()
}

/// Whether every character of `text` survives [`encode`] unchanged.
pub fn can_encode(text: &str) -> bool {
    text.chars().all(|c| c == '?' || encode_char(c) != b'?')
}

fn encode_char(c: char) -> u8 {
    let code = c as u32;
    match code {
        0x09 => b' ',
        0x20..=0x7E | 0xA0..=0xFF => code as u8,
        _ => match c {
            '€' => 0x80,
            '‚' => 0x82,
            'ƒ' => 0x83,
            '„' => 0x84,
            '…' => 0x85,
            '†' => 0x86,
            '‡' => 0x87,
            'ˆ' => 0x88,
            '‰' => 0x89,
            'Š' => 0x8A,
            '‹' => 0x8B,
            'Œ' => 0x8C,
            'Ž' => 0x8E,
            '‘' => 0x91,
            '’' => 0x92,
            '“' => 0x93,
            '”' => 0x94,
            '•' => 0x95,
            '–' => 0x96,
            '—' => 0x97,
            '˜' => 0x98,
            '™' => 0x99,
            'š' => 0x9A,
            '›' => 0x9B,
            'œ' => 0x9C,
            'ž' => 0x9E,
            'Ÿ' => 0x9F,
            '\u{2212}' => b'-',
            '\u{2010}' | '\u{2011}' => b'-',
            '\u{00A0}' | '\u{2002}'..='\u{200A}' => b' ',
            _ => b'?',
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_latin_and_smart_quotes() {
        assert_eq!(encode("Rp 1.500 – “ok” é"), b"Rp 1.500 \x96 \x93ok\x94 \xE9".to_vec());
        assert_eq!(encode("日"), b"?".to_vec());
        assert!(can_encode("Halo, dunia!"));
        assert!(!can_encode("日本"));
    }
}
