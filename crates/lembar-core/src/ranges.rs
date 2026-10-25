use crate::{Error, Result};

/// Parses a range list such as `"1-3, 5, 8-"` into groups of zero-based page
/// indices, one group per comma-separated part. An open end (`8-`) runs to the
/// last page; a reversed range (`5-3`) yields its pages in reverse order.
pub fn parse_ranges(input: &str, page_count: u32) -> Result<Vec<Vec<u32>>> {
    let bad = || Error::InvalidRange(input.trim().to_string());
    let parse = |s: &str| -> Result<u32> {
        let n: u32 = s.trim().parse().map_err(|_| bad())?;
        if n == 0 || n > page_count {
            return Err(Error::PageOutOfRange { page: n, count: page_count });
        }
        Ok(n)
    };

    let mut groups = Vec::new();
    for part in input.split([',', ';']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let normalized = part.replace(['–', '—'], "-");
        let (start, end) = match normalized.split_once('-') {
            None => {
                let n = parse(&normalized)?;
                (n, n)
            }
            Some((a, b)) => {
                let a = if a.trim().is_empty() { 1 } else { parse(a)? };
                let b = if b.trim().is_empty() { page_count } else { parse(b)? };
                (a, b)
            }
        };
        let group: Vec<u32> = if start <= end {
            (start..=end).map(|n| n - 1).collect()
        } else {
            (end..=start).rev().map(|n| n - 1).collect()
        };
        groups.push(group);
    }
    if groups.is_empty() {
        return Err(bad());
    }
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mixed_ranges() {
        assert_eq!(parse_ranges("1-3, 5, 7-", 8).unwrap(), vec![vec![0, 1, 2], vec![4], vec![6, 7]]);
        assert_eq!(parse_ranges("3-1", 3).unwrap(), vec![vec![2, 1, 0]]);
        assert_eq!(parse_ranges("2–4", 4).unwrap(), vec![vec![1, 2, 3]]);
        assert_eq!(parse_ranges("-2", 4).unwrap(), vec![vec![0, 1]]);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_ranges("", 3).is_err());
        assert!(parse_ranges("0", 3).is_err());
        assert!(parse_ranges("4", 3).is_err());
        assert!(parse_ranges("a-b", 3).is_err());
    }
}
