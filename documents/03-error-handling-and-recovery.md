
# Chapter 3: Error Handling & Recovery

Welcome to Chapter 3 of the **Go Systems Blueprint**. In previous chapters, we established foundational syntax, memory models, stack/heap allocation, and pointer mechanics. We now turn our attention to one of the most defining and opinionated aspects of Go’s design: **explicit error handling and panic recovery**.

Unlike languages that rely on throwing and catching exceptions (`try`/`catch`/`throw`), Go treats errors as ordinary values. This design choice forces developers to confront failure states explicitly at every call site, eliminating hidden control-flow jumps and ensuring predictable, transparent execution paths in high-throughput distributed systems.

---

## 3.1 Idiomatic Error Handling and the `error` Interface

In Go, errors are represented by the built-in `error` interface, which requires only a single method:

```go
type error interface {
    Error() string
}
```

Since errors are values, handling them is just standard conditional control flow. If a function can fail, it returns and `error` as the final return value. The caller is strictly obligated to check `if err != nil`

```go
package main

import (
	"errors"
	"fmt"
	"os"
)

// ConnectToDatabase simulates establishing a network socket connection.
func ConnectToDatabase(connectionString string) error {
	if connectionString == "" {
		return errors.New("connection string cannot be empty")
	}

	if connectionString != "postgres://cluster-leader:5432" {
		return os.ErrPermission // Return a standard sentinel error.
	}

	return nil
}

func main() {
	err := ConnectToDatabase("invalid-connection-string")

	if err != nil {
		// Idiomatic error checking and logging pattern.
		fmt.Printf("Critical failure: failed to establish database session: %v\n", err)
		return
	}

	fmt.Println("Database connection established successfully.")
}
```
---

## 3.2 Custom Error Types and Structured Metadata

For complex backend systems, basic string errors (errors.New) lack the metadata needed for intelligent recovery (e.g., error codes, retry flags, subsystem IDs and timestamps).
Go allows you to implement custom error structs by defining the `Error() string` method on any custom type.

```go
package main

import (
	"fmt"
	"time"
)

// ClusterNodeError represents a structured, context-rich error for distributed node failures.
type ClusterNodeError struct {
	NodeID          string
	Operation       string
	Timestamp       time.Time
	UnderlyingError error
}

// Error satisfies the built-in error interface using clusterError as the receiver pointer.
func (clusterError *ClusterNodeError) Error() string {
	return fmt.Sprintf("[%s] node %s failed during %s at %s: %v", 
		clusterError.Timestamp.Format(time.RFC3339), clusterError.NodeID, clusterError.Operation, clusterError.Timestamp, clusterError.UnderlyingError)
}

// Unwrap allows custom errors to integrate cleanly with Go's standard unwrap mechanics.
func (clusterError *ClusterNodeError) Unwrap() error {
	return clusterError.UnderlyingError
}

func PerformNodeSync(nodeID string) error {
	// Simulate a low-level timeout error.
	underlyingErr := fmt.Errorf("network socket timeout")
	
	return &ClusterNodeError{
		NodeID:          nodeID,
		Operation:       "StateSync",
		Timestamp:       time.Now(),
		UnderlyingError: underlyingErr,
	}
}

func main() {
	err := PerformNodeSync("node-delta-04")

	if err != nil {
		fmt.Println("Caught structured system error:")
		fmt.Println(err)
	}
}
```
---

## 3.3 Error Wrapping, Unwrapping, and Inspection (error.Is & error.As)

When building layered architectures (e.g., HTTP handler calling service layer, calling database layer), lower-level errors must be wrapped with higher-level context without destroying the root cause.

- **fmt.Errorf with %w:** Wraps an error while preserving its underlying type.
- **error.Is:** Checks if an error (or any error wrappers inside it) matches a specific target sentinel error.
- **error.As**: Casts a wrapped error to a specific custom error type for deep inspection.

```go
package main

import (
	"errors"
	"fmt"
	"os"
)

func ReadConfigurationFile(path string) error {
	file, err := os.Open(path)

	if err != nil {
		// Wrap the low-level OS error with high-level context using the %w verb.
		return fmt.Errorf("failed to load system configuration: %w", err)
	}

	defer file.Close()

	return nil
}

func main() {
	err := ReadConfigurationFile("/etc/nonexistent-cluster.conf")

	if err != nil {
		fmt.Printf("Execution halted: %v\n", err)

		// Use errors.Is to inspect if the root cause was a file-not-found error.
		if errors.Is(err, os.ErrNotExist) {
			fmt.Println("Recovery Action: Configuration file missing. Falling back to default cluster profile.")
		}
	}
}
```
---

## 3.4 Panics and the Panic Lifecycle

While standard errors represent predictable operational failures (e.g., invalid input, network timeouts, disk full), panics represent unrecoverable runtime anomalies—such as indexing out of bounds, dereferencing a `nil` pointer, or calling `panic()` explicitly.

When a panic occurs:
	1. Normal execution stops immediately.
	2. All deferred functions (defer) in the current coroutine are executed in LIFO (Last-In, First-Out) order.
	3. The program crashes, printing a stack trace to standard error, unless explicitly recovered.

```go
package main

import "fmt"

func InitializeSubsystem() {
	defer fmt.Println("Deferred cleanup: releasing socket descriptors.")
	
	fmt.Println("Initializing hardware modules...")
	
	// Explicit panic simulation for catastrophic failure state.
	panic("hardware initialization fault: core processor unresponsive")
	
	// Unreachable code.
	fmt.Println("Subsystem active.")
}

func main() {
	fmt.Println("System boot sequence initiated.")

	InitializeSubsystem()

	fmt.Println("System boot complete.") // This line will never execute due to the unrecovered panic.
}
```
---

## 3.5 Safe Recovery with recover()

The `recover()` built-in function halts a panic's stack unwinding sequence, regains control of the goroutine, and returns the value passed to `panic()`.

Critical Rule: `recover()` is only effective when called directly inside a deferred function. Calling it anywhere else has no effect. Furthermore, panics do not cross goroutine boundaries, a panic in a worker goroutine will crash the entire application if not recovered within that specific goroutine.

```go
package main

import (
	"fmt"
	"runtime/debug"
)

func SafeWorkerPoolTask(taskID int) {
	// Deferred function equipped with recover() to prevent worker crashes.
	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Printf("[RECOVERY CAUGHT] Worker task #%d panicked! Error: %v\n", taskID, recovered)
			fmt.Println("Stack Trace Dump:")

			debug.PrintStack()
		}
	}()

	fmt.Printf("Executing worker task #%d...\n", taskID)
	
	if taskID == 3 {
		panic("segmentation fault simulated in memory buffer")
	}

	fmt.Printf("Worker task #%d completed successfully.\n", taskID)
}

func main() {
	fmt.Println("Starting concurrent worker supervisor...")

	for index := 1; index <= 5; index++ {
		SafeWorkerPoolTask(index)
	}

	fmt.Println("Worker supervisor shut down cleanly.")
}
```
---

## 3.6 Production Error Architecture & Guidelines

In a high-scale distributed systems, following consistent error boundaries protects services from cascading failures:
1. **Never Ignore Errors:** Avoid using blank identifiers (`_ = operation()`) unless the error is genuinely safe to discard (e.g., closing idle read-only file handle).
2. **Sentinel Errors for Expected States:** Use exported package-level variables (e.g., `ErrRecordNotFound`) for predictable states callers need to check via `errors.Is`.
3. **Reserve Panics for initialization Faults:** Panics should be strictly restricted to package initialization (`init()`) or catastrophic fatal conditions where the program cannot safely continue execution (e.g., failure to bind a core network port on startup).
4. **Wrap with Context:** Always add contextual metadata at package boundaries (`fmt.Errorf("context: %w", err)`) so debugging distributed traces is fast and deterministic.

---

---

## Key Takeaways

- **Errors as Values:** Go has no exceptions. Errors are ordinary return values that force explicit handling at every call site.

- **Custom Error Structs:** Implement the `error` interface (`Error() string`) alongside `Unwrap()` to attach rich operational metadata.

- **Wrapping & Inspection:** Use `fmt.Errorf("%w", err)` to wrap errors, and `errors.Is` / `errors.As` to inspect error hierarchies cleanly.

- **Panics vs. Errors:** Errors represent expected failures; panics represent unrecoverable runtime bugs.

- **Goroutine-Local Recovery:** `recover()` only works inside deferred functions and prevents goroutine crashes, securing production worker pools against unexpected faults.
