fn compute_average(total: i64, count: i64) -> i64 {
    // BUG: `count` can be zero, and this integer division will panic.
    total / count
}

fn main() {
    let numbers = [10_i64, 20, 30];
    let total: i64 = numbers.iter().sum();

    // Intentional bug input for demo/debugging.
    let count = 0_i64;

    let avg = compute_average(total, count);
    println!("average={avg}");
}
