fn compute_total(input: &[i64]) -> i64 {
    let mut total = 0;
    for value in input {
        total += value;
    }
    total
}

fn main() {
    let data = vec![3_i64, 7, 11, 13];
    let total = compute_total(&data);
    println!("values={data:?} total={total}");
}
